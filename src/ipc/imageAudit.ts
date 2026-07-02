import { existsSync, readdirSync } from 'fs'
import { join, extname } from 'path'
import type Database from 'better-sqlite3'
import { getActiveProfileId } from '../db/queries'
import type { AuditEntry, ConclusionDicomLink, DicomStudyLink } from '../types/ipc'

const IMAGE_EXTS = new Set(['.tif', '.tiff', '.jpg', '.jpeg', '.png'])

interface StationConfig {
  number: number
  has_conclusion: boolean
}

interface ModuleConfig {
  code: string
  stations: StationConfig[]
}

export function runImageAudit(
  db: Database.Database,
  targetRoot: string,
  modulesConfig: ModuleConfig[]
): AuditEntry[] {
  const profileId = getActiveProfileId(db)
  const students = db
    .prepare(
      `SELECT ps.student_id, ps.full_name, se.module_code
       FROM profile_students ps
       JOIN student_enrollments se
        ON se.profile_id = ps.profile_id
       AND se.student_id = ps.student_id
       WHERE ps.profile_id = ?
       ORDER BY se.module_code, ps.full_name`
    )
    .all(profileId) as { student_id: string; full_name: string; module_code: string }[]

  const moduleStationsMap = new Map<string, StationConfig[]>()
  for (const mod of modulesConfig) {
    moduleStationsMap.set(mod.code, mod.stations)
  }

  const dicomLinks = db.prepare(`
    SELECT *
    FROM dicom_study_links
    ORDER BY imported_at DESC, id DESC
  `).all() as DicomStudyLink[]
  const dicomLinksByStation = new Map<string, DicomStudyLink[]>()
  for (const link of dicomLinks) {
    const key = `${link.student_id}|${link.module_code}|${link.station_number}`
    const existing = dicomLinksByStation.get(key) ?? []
    existing.push(link)
    dicomLinksByStation.set(key, existing)
  }

  const conclusionLinks = db.prepare(`
    SELECT *
    FROM conclusion_dicom_links
    WHERE profile_id = ?
  `).all(profileId) as ConclusionDicomLink[]
  const conclusionLinksByStation = new Map<string, ConclusionDicomLink>()
  for (const link of conclusionLinks) {
    conclusionLinksByStation.set(`${link.student_id}|${link.module_code}|${link.station_number}`, link)
  }

  const entries: AuditEntry[] = []

  for (const student of students) {
    const stations = moduleStationsMap.get(student.module_code)
    if (!stations) continue

    for (const station of stations) {
      const stationDir = join(
        targetRoot,
        student.student_id,
        student.module_code,
        'Practical',
        `Station ${station.number}`
      )

      const dirExists = existsSync(stationDir)
      let img1: string | null = null
      let img2: string | null = null
      let conclusion: string | null = null

      if (dirExists) {
        let files: string[]
        try {
          files = readdirSync(stationDir)
        } catch {
          files = []
        }

        const images: string[] = []
        let img1Slot: string | null = null
        let img2Slot: string | null = null
        for (const f of files) {
          const ext = extname(f).toLowerCase()
          const nameLower = f.toLowerCase()
          if (nameLower.startsWith('conclusion_')) {
            conclusion = f
          } else if (/form/i.test(f)) {
            if (!conclusion) conclusion = f
          } else if (IMAGE_EXTS.has(ext) && nameLower.startsWith('img1_')) {
            img1Slot = f
          } else if (IMAGE_EXTS.has(ext) && nameLower.startsWith('img2_')) {
            img2Slot = f
          } else if (IMAGE_EXTS.has(ext)) {
            images.push(f)
          } else if (ext === '.pdf' && !conclusion) {
            conclusion = f
          }
        }
        images.sort((a, b) => a.localeCompare(b))
        img1 = img1Slot ?? images[0] ?? null
        img2 = img2Slot ?? images[img1Slot ? 0 : 1] ?? null
      }

      entries.push({
        student_id: student.student_id,
        full_name: student.full_name,
        module_code: student.module_code,
        station_number: station.number,
        station_dir: stationDir,
        dir_exists: dirExists,
        img1,
        img2,
        conclusion,
        conclusion_dicom_link:
          conclusionLinksByStation.get(`${student.student_id}|${student.module_code}|${station.number}`) ?? null,
        requires_conclusion: station.has_conclusion,
        dicom_links: dicomLinksByStation.get(`${student.student_id}|${student.module_code}|${station.number}`) ?? [],
        active_dicom_link:
          dicomLinksByStation.get(`${student.student_id}|${student.module_code}|${station.number}`)?.[0] ?? null
      })
    }
  }

  return entries
}
