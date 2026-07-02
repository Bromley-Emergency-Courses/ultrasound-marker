import type Database from 'better-sqlite3'
import { Buffer } from 'buffer'
import { nativeImage } from 'electron'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, join } from 'path'
import { data as dcmjsData } from 'dcmjs'
import { getActiveProfileId, getStudentByShortId, resolveDicomStationNumber, resolveModuleAlias } from '../db/queries'
import type {
  ConclusionDicomLink,
  ConclusionDicomLinkResult,
  DicomParsedPatientId,
  DicomManualLinkResult,
  DicomPreparedExportGroup,
  DicomPreparedExportResult,
  DicomPreparedUploadItem,
  DicomPreparedUploadResult,
  DicomServerConfig,
  DicomStudyCandidate,
  DicomStudyCandidateDetails,
  DicomStudyLink,
  DicomStudyPreview,
  DicomStudyPreviews,
  DicomSyncResult,
  DicomUnlinkResult,
  DicomUploadItem,
  DicomUploadResult,
  DicomUnresolvedStudyDetails,
  DicomUnresolvedStudy,
  ReferenceDicomLink,
  ReferenceDicomLinkResult
} from '../types/ipc'

interface OrthancStudyDetails {
  ID: string
  MainDicomTags?: Record<string, string>
  PatientMainDicomTags?: Record<string, string>
  Series?: string[]
}

interface OrthancSeriesDetails {
  ID: string
  MainDicomTags?: Record<string, string>
  Instances?: string[]
}

type ExportSourceFileKind = 'image' | 'dicom' | 'unsupported'

interface ExportSourceFile {
  path: string
  kind: ExportSourceFileKind
  ext: string
}

interface ValidExportGroup extends DicomPreparedExportGroup {
  status: 'valid'
  sourceFiles: ExportSourceFile[]
}

interface DicomParsedReferencePatientId {
  module_code: string
  source_station_number: number
  station_number: number
}

interface DicomParsedConclusionPatientId {
  student_short_id: string
  module_code: string
  source_station_number: number
  station_number: number
}

const STATION_EXPORT_FOLDER_PATTERN = /^(\d{6})-([A-Z]{2})-(\d{1,2})$/i
const CONCLUSION_EXPORT_FILE_PATTERN = /^(\d{6})-([A-Z]{2})-(\d{1,2})c$/i
const REFERENCE_EXPORT_FOLDER_PATTERN = /^REF-([A-Z]{2})-(\d{1,2})$/i
const PREPARED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png'])
const PREPARED_CONCLUSION_EXTS = new Set(['.jpg', '.jpeg', '.png'])
const PREPARED_DICOM_EXTS = new Set(['.dcm'])
const PREPARED_UNSUPPORTED_EXTS = new Set(['.tif', '.tiff'])
const EXPLICIT_VR_LITTLE_ENDIAN_UID = '1.2.840.10008.1.2.1'
const SECONDARY_CAPTURE_IMAGE_STORAGE_UID = '1.2.840.10008.5.1.4.1.1.7'

function padStationNumber(stationNumber: number): string {
  return String(stationNumber).padStart(2, '0')
}

function makePatientId(shortId: string, moduleCode: string, stationNumber: number): string {
  return `${shortId}-${moduleCode}-${padStationNumber(stationNumber)}`
}

function makeReferencePatientId(moduleCode: string, stationNumber: number): string {
  return `REF-${moduleCode}-${padStationNumber(stationNumber)}`
}

function makeConclusionPatientId(shortId: string, moduleCode: string, stationNumber: number): string {
  return `${shortId}-${moduleCode}-${padStationNumber(stationNumber)}c`
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

function classifyExportSourceFile(filePath: string): ExportSourceFile | null {
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size <= 0) return null

  const ext = extname(filePath).toLowerCase()
  if (PREPARED_IMAGE_EXTS.has(ext)) {
    return { path: filePath, kind: 'image', ext }
  }
  if (PREPARED_DICOM_EXTS.has(ext)) {
    return { path: filePath, kind: 'dicom', ext }
  }
  if (PREPARED_UNSUPPORTED_EXTS.has(ext)) {
    return { path: filePath, kind: 'unsupported', ext }
  }
  return null
}

function collectFilesRecursive(dirPath: string): ExportSourceFile[] {
  const files: ExportSourceFile[] = []

  let rootStat
  try {
    rootStat = statSync(dirPath)
  } catch {
    return files
  }

  if (rootStat.isFile()) {
    const sourceFile = classifyExportSourceFile(dirPath)
    return sourceFile ? [sourceFile] : []
  }

  function scan(dir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry === '.DS_Store') continue
      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        scan(fullPath)
        continue
      }

      const sourceFile = classifyExportSourceFile(fullPath)
      if (sourceFile) files.push(sourceFile)
    }
  }

  scan(dirPath)
  files.sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
  return files
}

function hasActiveProfileStation(
  db: Database.Database,
  moduleCode: string,
  stationNumber: number
): boolean {
  const profileId = getActiveProfileId(db)
  const row = db.prepare(`
    SELECT 1
    FROM assessment_stations
    WHERE profile_id = ? AND module_code = ? AND station_number = ?
    LIMIT 1
  `).get(profileId, moduleCode, stationNumber) as { 1: number } | undefined
  return Boolean(row)
}

function activeProfileStationRequiresConclusion(
  db: Database.Database,
  moduleCode: string,
  stationNumber: number
): boolean {
  const profileId = getActiveProfileId(db)
  const row = db.prepare(`
    SELECT 1
    FROM station_form_fields
    WHERE profile_id = ?
      AND module_code = ?
      AND station_number = ?
      AND upper(field_id) LIKE '%CONCLUSION%'
    LIMIT 1
  `).get(profileId, moduleCode, stationNumber) as { 1: number } | undefined
  return Boolean(row)
}

function scanPreparedExportGroups(db: Database.Database, rootPath: string): DicomPreparedExportGroup[] {
  const groups: DicomPreparedExportGroup[] = []

  function scan(dir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        const stationMatch = STATION_EXPORT_FOLDER_PATTERN.exec(entry)
        const referenceMatch = REFERENCE_EXPORT_FOLDER_PATTERN.exec(entry)
        if (stationMatch) {
          groups.push(buildPreparedExportGroup(db, fullPath, stationMatch))
        } else if (referenceMatch) {
          groups.push(buildPreparedReferenceExportGroup(db, fullPath, referenceMatch))
        } else {
          scan(fullPath)
        }
      } else {
        const ext = extname(entry).toLowerCase()
        const nameNoExt = basename(entry, ext)
        const conclusionMatch = CONCLUSION_EXPORT_FILE_PATTERN.exec(nameNoExt)
        if (conclusionMatch) {
          groups.push(buildPreparedConclusionFormGroup(db, fullPath, conclusionMatch))
        }
      }
    }
  }

  scan(rootPath)
  groups.sort((a, b) => a.key.localeCompare(b.key))
  return groups
}

function buildPreparedExportGroup(
  db: Database.Database,
  folderPath: string,
  match: RegExpExecArray
): DicomPreparedExportGroup {
  const shortId = match[1]
  const rawModuleCode = match[2].toUpperCase()
  const sourceStationNumber = Number.parseInt(match[3], 10)
  const resolvedModuleCode = resolveModuleAlias(db, rawModuleCode)
  const moduleCode = resolvedModuleCode ?? rawModuleCode
  const stationNumber = resolvedModuleCode
    ? resolveDicomStationNumber(db, moduleCode, sourceStationNumber)
    : sourceStationNumber
  const patientId = makePatientId(shortId, moduleCode, sourceStationNumber)
  const key = patientId
  const sourceFiles = collectFilesRecursive(folderPath)
  const imageCount = sourceFiles.filter((file) => file.kind === 'image').length
  const dicomCount = sourceFiles.filter((file) => file.kind === 'dicom').length
  const unsupportedCount = sourceFiles.filter((file) => file.kind === 'unsupported').length
  const warnings: string[] = []

  if (!resolvedModuleCode) {
    return invalidPreparedGroup(
      key,
      'station',
      folderPath,
      shortId,
      moduleCode,
      sourceStationNumber,
      stationNumber,
      patientId,
      sourceFiles,
      `Module code or alias "${rawModuleCode}" is not configured.`
    )
  }

  const student = getStudentByShortId(db, shortId, moduleCode)
  if (!student) {
    return invalidPreparedGroup(
      key,
      'station',
      folderPath,
      shortId,
      moduleCode,
      sourceStationNumber,
      stationNumber,
      patientId,
      sourceFiles,
      `No imported student matches short ID ${shortId} in module ${moduleCode}.`
    )
  }

  if (!hasActiveProfileStation(db, moduleCode, stationNumber)) {
    const reason = sourceStationNumber === stationNumber
      ? `Station ${stationNumber} is not configured for module ${moduleCode}.`
      : `Source station ${sourceStationNumber} maps to Station ${stationNumber}, which is not configured for module ${moduleCode}.`
    return invalidPreparedGroup(
      key,
      'station',
      folderPath,
      shortId,
      moduleCode,
      sourceStationNumber,
      stationNumber,
      patientId,
      sourceFiles,
      reason
    )
  }

  if (imageCount + dicomCount === 0) {
    return invalidPreparedGroup(
      key,
      'station',
      folderPath,
      shortId,
      moduleCode,
      sourceStationNumber,
      stationNumber,
      patientId,
      sourceFiles,
      unsupportedCount > 0
        ? 'No supported JPG, PNG, or DICOM files found. TIFF files are not supported in this workflow.'
        : 'No supported JPG, PNG, or DICOM files found.'
    )
  }

  if (unsupportedCount > 0) {
    warnings.push(`${unsupportedCount} TIFF file(s) will be skipped.`)
  }
  if (imageCount + dicomCount > 2) {
    warnings.push(`${imageCount + dicomCount} images will upload; marking currently uses the first two previews.`)
  }

  return {
    key,
    group_type: 'station',
    folder_path: folderPath,
    status: 'valid',
    student_id: student.student_id,
    full_name: student.full_name,
    student_short_id: shortId,
    module_code: moduleCode,
    source_station_number: sourceStationNumber,
    station_number: stationNumber,
    patient_id: patientId,
    file_count: sourceFiles.length,
    image_count: imageCount,
    dicom_count: dicomCount,
    conclusion_count: 0,
    unsupported_count: unsupportedCount,
    warnings,
    planned_action: sourceStationNumber === stationNumber
      ? `Create one DICOM study for ${student.student_id} ${moduleCode} Station ${stationNumber}.`
      : `Create one DICOM study for ${student.student_id} ${moduleCode} source Station ${sourceStationNumber} mapped to Station ${stationNumber}.`
  }
}

function buildPreparedReferenceExportGroup(
  db: Database.Database,
  folderPath: string,
  match: RegExpExecArray
): DicomPreparedExportGroup {
  const rawModuleCode = match[1].toUpperCase()
  const sourceStationNumber = Number.parseInt(match[2], 10)
  const resolvedModuleCode = resolveModuleAlias(db, rawModuleCode)
  const moduleCode = resolvedModuleCode ?? rawModuleCode
  const stationNumber = resolvedModuleCode
    ? resolveDicomStationNumber(db, moduleCode, sourceStationNumber)
    : sourceStationNumber
  const patientId = makeReferencePatientId(moduleCode, sourceStationNumber)
  const key = patientId
  const sourceFiles = collectFilesRecursive(folderPath)
  const imageCount = sourceFiles.filter((file) => file.kind === 'image').length
  const dicomCount = sourceFiles.filter((file) => file.kind === 'dicom').length
  const unsupportedCount = sourceFiles.filter((file) => file.kind === 'unsupported').length
  const warnings: string[] = []

  if (!resolvedModuleCode) {
    return invalidPreparedGroup(
      key,
      'reference',
      folderPath,
      'REF',
      moduleCode,
      sourceStationNumber,
      stationNumber,
      patientId,
      sourceFiles,
      `Module code or alias "${rawModuleCode}" is not configured.`
    )
  }

  if (!hasActiveProfileStation(db, moduleCode, stationNumber)) {
    const reason = sourceStationNumber === stationNumber
      ? `Reference station ${stationNumber} is not configured for module ${moduleCode}.`
      : `Reference source station ${sourceStationNumber} maps to Station ${stationNumber}, which is not configured for module ${moduleCode}.`
    return invalidPreparedGroup(
      key,
      'reference',
      folderPath,
      'REF',
      moduleCode,
      sourceStationNumber,
      stationNumber,
      patientId,
      sourceFiles,
      reason
    )
  }

  if (imageCount + dicomCount === 0) {
    return invalidPreparedGroup(
      key,
      'reference',
      folderPath,
      'REF',
      moduleCode,
      sourceStationNumber,
      stationNumber,
      patientId,
      sourceFiles,
      unsupportedCount > 0
        ? 'No supported JPG, PNG, or DICOM files found. TIFF files are not supported in this workflow.'
        : 'No supported JPG, PNG, or DICOM files found.'
    )
  }

  if (unsupportedCount > 0) {
    warnings.push(`${unsupportedCount} TIFF file(s) will be skipped.`)
  }
  if (imageCount + dicomCount > 2) {
    warnings.push(`${imageCount + dicomCount} images will upload; reference linking currently uses the first two previews.`)
  }

  return {
    key,
    group_type: 'reference',
    folder_path: folderPath,
    status: 'valid',
    student_short_id: 'REF',
    module_code: moduleCode,
    source_station_number: sourceStationNumber,
    station_number: stationNumber,
    patient_id: patientId,
    file_count: sourceFiles.length,
    image_count: imageCount,
    dicom_count: dicomCount,
    conclusion_count: 0,
    unsupported_count: unsupportedCount,
    warnings,
    planned_action: sourceStationNumber === stationNumber
      ? `Create one DICOM reference study for ${moduleCode} Station ${stationNumber}.`
      : `Create one DICOM reference study for ${moduleCode} source Station ${sourceStationNumber} mapped to Station ${stationNumber}.`
  }
}

function buildPreparedConclusionFormGroup(
  db: Database.Database,
  filePath: string,
  match: RegExpExecArray
): DicomPreparedExportGroup {
  const shortId = match[1]
  const rawModuleCode = match[2].toUpperCase()
  const sourceStationNumber = Number.parseInt(match[3], 10)
  const resolvedModuleCode = resolveModuleAlias(db, rawModuleCode)
  const moduleCode = resolvedModuleCode ?? rawModuleCode
  const stationNumber = resolvedModuleCode
    ? resolveDicomStationNumber(db, moduleCode, sourceStationNumber)
    : sourceStationNumber
  const key = `${shortId}-${moduleCode}-${padStationNumber(sourceStationNumber)}c`
  const ext = extname(filePath).toLowerCase()
  const sourceFiles: ExportSourceFile[] = [{
    path: filePath,
    kind: PREPARED_CONCLUSION_EXTS.has(ext) ? 'image' : 'unsupported',
    ext
  }]

  if (!resolvedModuleCode) {
    return invalidPreparedGroup(
      key,
      'conclusion',
      filePath,
      shortId,
      moduleCode,
      sourceStationNumber,
      stationNumber,
      key,
      sourceFiles,
      `Module code or alias "${rawModuleCode}" is not configured.`
    )
  }

  const student = getStudentByShortId(db, shortId, moduleCode)
  if (!student) {
    return invalidPreparedGroup(
      key,
      'conclusion',
      filePath,
      shortId,
      moduleCode,
      sourceStationNumber,
      stationNumber,
      key,
      sourceFiles,
      `No imported student matches short ID ${shortId} in module ${moduleCode}.`
    )
  }

  if (!hasActiveProfileStation(db, moduleCode, stationNumber)) {
    const reason = sourceStationNumber === stationNumber
      ? `Station ${stationNumber} is not configured for module ${moduleCode}.`
      : `Source station ${sourceStationNumber} maps to Station ${stationNumber}, which is not configured for module ${moduleCode}.`
    return invalidPreparedGroup(
      key,
      'conclusion',
      filePath,
      shortId,
      moduleCode,
      sourceStationNumber,
      stationNumber,
      key,
      sourceFiles,
      reason
    )
  }

  if (!activeProfileStationRequiresConclusion(db, moduleCode, stationNumber)) {
    return invalidPreparedGroup(
      key,
      'conclusion',
      filePath,
      shortId,
      moduleCode,
      sourceStationNumber,
      stationNumber,
      key,
      sourceFiles,
      `Station ${stationNumber} in module ${moduleCode} is not configured to require a conclusion.`
    )
  }

  if (!PREPARED_CONCLUSION_EXTS.has(ext)) {
    return invalidPreparedGroup(
      key,
      'conclusion',
      filePath,
      shortId,
      moduleCode,
      sourceStationNumber,
      stationNumber,
      key,
      sourceFiles,
      'Conclusion form upload currently supports JPG or PNG.'
    )
  }

  return {
    key,
    group_type: 'conclusion',
    folder_path: filePath,
    status: 'valid',
    student_id: student.student_id,
    full_name: student.full_name,
    student_short_id: shortId,
    module_code: moduleCode,
    source_station_number: sourceStationNumber,
    station_number: stationNumber,
    patient_id: key,
    file_count: 1,
    image_count: 0,
    dicom_count: 0,
    conclusion_count: 1,
    unsupported_count: 0,
    warnings: [],
    planned_action: sourceStationNumber === stationNumber
      ? `Create one DICOM conclusion-form study for ${student.student_id} ${moduleCode} Station ${stationNumber}.`
      : `Create one DICOM conclusion-form study for ${student.student_id} ${moduleCode} source Station ${sourceStationNumber} mapped to Station ${stationNumber}.`
  }
}

function invalidPreparedGroup(
  key: string,
  groupType: 'station' | 'reference' | 'conclusion',
  folderPath: string,
  shortId: string,
  moduleCode: string,
  sourceStationNumber: number,
  stationNumber: number,
  patientId: string,
  sourceFiles: ExportSourceFile[],
  reason: string
): DicomPreparedExportGroup {
  return {
    key,
    group_type: groupType,
    folder_path: folderPath,
    status: 'invalid',
    reason,
    student_short_id: shortId,
    module_code: moduleCode,
    source_station_number: sourceStationNumber,
    station_number: stationNumber,
    patient_id: patientId,
    file_count: sourceFiles.length,
    image_count: groupType === 'conclusion' ? 0 : sourceFiles.filter((file) => file.kind === 'image').length,
    dicom_count: sourceFiles.filter((file) => file.kind === 'dicom').length,
    conclusion_count: groupType === 'conclusion' ? sourceFiles.filter((file) => file.kind !== 'unsupported').length : 0,
    unsupported_count: sourceFiles.filter((file) => file.kind === 'unsupported').length,
    warnings: [],
    planned_action: 'Skipped.'
  }
}

function preparedExportResult(rootPath: string, groups: DicomPreparedExportGroup[]): DicomPreparedExportResult {
  return {
    root_path: rootPath,
    scanned_groups: groups.length,
    valid_groups: groups.filter((group) => group.status === 'valid').length,
    invalid_groups: groups.filter((group) => group.status === 'invalid').length,
    groups
  }
}

function typedValidGroup(
  group: DicomPreparedExportGroup,
  sourceFiles: ExportSourceFile[]
): ValidExportGroup {
  return {
    ...group,
    status: 'valid',
    student_id: group.student_id!,
    full_name: group.full_name!,
    sourceFiles
  }
}

function getPreparedGroupPatientName(group: ValidExportGroup): string {
  return group.group_type === 'reference' ? 'REFERENCE' : group.student_id ?? group.student_short_id
}

function getPreparedGroupStudyDescription(group: ValidExportGroup): string {
  const prefix =
    group.group_type === 'reference'
      ? 'Reference'
      : group.group_type === 'conclusion'
        ? 'Conclusion'
        : group.module_code
  return `${prefix} Station ${group.station_number}`
}

function getPreparedGroupSeriesDescription(group: ValidExportGroup): string {
  if (group.group_type === 'reference') return 'Ultrasound Marker reference images'
  if (group.group_type === 'conclusion') return 'Ultrasound Marker conclusion form'
  return 'Ultrasound Marker station images'
}

function rgbFromNativeImage(filePath: string): { width: number; height: number; rgb: Uint8Array } {
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) {
    throw new Error('Electron could not decode this image.')
  }
  const size = image.getSize()
  const bitmap = image.toBitmap()
  const rgb = new Uint8Array(size.width * size.height * 3)

  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < bitmap.length; sourceOffset += 4) {
    rgb[targetOffset++] = bitmap[sourceOffset + 2]
    rgb[targetOffset++] = bitmap[sourceOffset + 1]
    rgb[targetOffset++] = bitmap[sourceOffset]
  }

  return { width: size.width, height: size.height, rgb }
}

function writeGeneratedImageDicom(
  sourceFile: ExportSourceFile,
  group: ValidExportGroup,
  outputPath: string,
  studyInstanceUid: string,
  seriesInstanceUid: string,
  instanceNumber: number
): void {
  const image = rgbFromNativeImage(sourceFile.path)
  const nowDate = dcmjsData.DicomMetaDictionary.date()
  const nowTime = dcmjsData.DicomMetaDictionary.time()
  const sopInstanceUid = dcmjsData.DicomMetaDictionary.uid()
  const rgbBuffer = Buffer.from(image.rgb)
  const pixelDataBuffer =
    rgbBuffer.byteLength % 2 === 0
      ? rgbBuffer
      : Buffer.concat([rgbBuffer, Buffer.from([0])])

  const dataset: Record<string, unknown> = {
    _meta: {
      TransferSyntaxUID: {
        vr: 'UI',
        Value: [EXPLICIT_VR_LITTLE_ENDIAN_UID]
      }
    },
    _vrMap: {
      PixelData: 'OB'
    },
    SpecificCharacterSet: 'ISO_IR 192',
    SOPClassUID: SECONDARY_CAPTURE_IMAGE_STORAGE_UID,
    SOPInstanceUID: sopInstanceUid,
    StudyInstanceUID: studyInstanceUid,
    SeriesInstanceUID: seriesInstanceUid,
    PatientID: group.patient_id,
    PatientName: getPreparedGroupPatientName(group),
    StudyDescription: getPreparedGroupStudyDescription(group),
    SeriesDescription: getPreparedGroupSeriesDescription(group),
    Modality: 'OT',
    Manufacturer: 'Ultrasound Marker',
    ConversionType: 'WSD',
    StudyDate: nowDate,
    StudyTime: nowTime,
    SeriesDate: nowDate,
    SeriesTime: nowTime,
    ContentDate: nowDate,
    ContentTime: nowTime,
    InstanceNumber: instanceNumber,
    SamplesPerPixel: 3,
    PhotometricInterpretation: 'RGB',
    PlanarConfiguration: 0,
    Rows: image.height,
    Columns: image.width,
    BitsAllocated: 8,
    BitsStored: 8,
    HighBit: 7,
    PixelRepresentation: 0,
    PixelData: toArrayBuffer(pixelDataBuffer)
  }

  writeFileSync(outputPath, Buffer.from(dcmjsData.datasetToBuffer(dataset)))
}

function readDicomNaturalDataset(filePath: string): Record<string, unknown> {
  const bytes = readFileSync(filePath)
  const dicom = dcmjsData.DicomMessage.readFile(toArrayBuffer(bytes))
  const dataset = dcmjsData.DicomMetaDictionary.naturalizeDataset(dicom.dict)
  const meta = dcmjsData.DicomMetaDictionary.naturalizeDataset(dicom.meta)
  return { ...dataset, _meta: meta }
}

function writeNormalizedDicom(
  sourceFile: ExportSourceFile,
  group: ValidExportGroup,
  outputPath: string,
  studyInstanceUid: string,
  seriesInstanceUid: string,
  instanceNumber: number
): void {
  const dataset = readDicomNaturalDataset(sourceFile.path)
  const sopClassUid =
    typeof dataset.SOPClassUID === 'string'
      ? dataset.SOPClassUID
      : typeof dataset.MediaStorageSOPClassUID === 'string'
        ? dataset.MediaStorageSOPClassUID
        : SECONDARY_CAPTURE_IMAGE_STORAGE_UID
  const sopInstanceUid = dcmjsData.DicomMetaDictionary.uid()
  const meta = typeof dataset._meta === 'object' && dataset._meta ? dataset._meta as Record<string, unknown> : {}
  const originalTransferSyntaxUid =
    typeof meta.TransferSyntaxUID === 'string'
      ? meta.TransferSyntaxUID
      : EXPLICIT_VR_LITTLE_ENDIAN_UID

  dataset._meta = {
    ...meta,
    TransferSyntaxUID: {
      vr: 'UI',
      Value: [originalTransferSyntaxUid]
    }
  }
  dataset.SOPClassUID = sopClassUid
  dataset.SOPInstanceUID = sopInstanceUid
  dataset.StudyInstanceUID = studyInstanceUid
  dataset.SeriesInstanceUID = seriesInstanceUid
  dataset.PatientID = group.patient_id
  dataset.PatientName = getPreparedGroupPatientName(group)
  dataset.StudyDescription = getPreparedGroupStudyDescription(group)
  dataset.SeriesDescription = getPreparedGroupSeriesDescription(group)
  dataset.InstanceNumber = instanceNumber

  writeFileSync(outputPath, Buffer.from(dcmjsData.datasetToBuffer(dataset)))
}

function prepareGroupDicomFiles(group: ValidExportGroup, tempRoot: string): string[] {
  const outputPaths: string[] = []
  const studyInstanceUid = dcmjsData.DicomMetaDictionary.uid()
  const seriesInstanceUid = dcmjsData.DicomMetaDictionary.uid()
  const supportedFiles = group.sourceFiles.filter((file) => file.kind === 'image' || file.kind === 'dicom')

  supportedFiles.forEach((sourceFile, index) => {
    const outputPath = join(tempRoot, `${group.key.replace(/[^A-Z0-9-]/gi, '_')}_${index + 1}.dcm`)
    if (sourceFile.kind === 'dicom') {
      writeNormalizedDicom(sourceFile, group, outputPath, studyInstanceUid, seriesInstanceUid, index + 1)
    } else {
      writeGeneratedImageDicom(sourceFile, group, outputPath, studyInstanceUid, seriesInstanceUid, index + 1)
    }
    outputPaths.push(outputPath)
  })

  return outputPaths
}

export function parseDicomPatientId(
  patientId: string | null | undefined,
  resolveModule: (moduleOrAlias: string) => string | null = (value) => value,
  resolveStation: (moduleCode: string, sourceStationNumber: number) => number = (_moduleCode, value) => value
): DicomParsedPatientId | null {
  if (!patientId) return null
  const match = /^(\d{6})-([A-Z]{2})-(\d{1,2})$/.exec(patientId.trim().toUpperCase())
  if (!match) return null
  const moduleCode = resolveModule(match[2])
  if (!moduleCode) return null
  const sourceStationNumber = Number.parseInt(match[3], 10)
  return {
    student_short_id: match[1],
    module_code: moduleCode,
    source_station_number: sourceStationNumber,
    station_number: resolveStation(moduleCode, sourceStationNumber)
  }
}

export function parseReferenceDicomPatientId(
  patientId: string | null | undefined,
  resolveModule: (moduleOrAlias: string) => string | null = (value) => value,
  resolveStation: (moduleCode: string, sourceStationNumber: number) => number = (_moduleCode, value) => value
): DicomParsedReferencePatientId | null {
  if (!patientId) return null
  const match = REFERENCE_EXPORT_FOLDER_PATTERN.exec(patientId.trim().toUpperCase())
  if (!match) return null
  const moduleCode = resolveModule(match[1])
  if (!moduleCode) return null
  const sourceStationNumber = Number.parseInt(match[2], 10)
  return {
    module_code: moduleCode,
    source_station_number: sourceStationNumber,
    station_number: resolveStation(moduleCode, sourceStationNumber)
  }
}

export function parseConclusionDicomPatientId(
  patientId: string | null | undefined,
  resolveModule: (moduleOrAlias: string) => string | null = (value) => value,
  resolveStation: (moduleCode: string, sourceStationNumber: number) => number = (_moduleCode, value) => value
): DicomParsedConclusionPatientId | null {
  if (!patientId) return null
  const match = /^(\d{6})-([A-Z]{2})-(\d{1,2})C$/i.exec(patientId.trim().toUpperCase())
  if (!match) return null
  const moduleCode = resolveModule(match[2])
  if (!moduleCode) return null
  const sourceStationNumber = Number.parseInt(match[3], 10)
  return {
    student_short_id: match[1],
    module_code: moduleCode,
    source_station_number: sourceStationNumber,
    station_number: resolveStation(moduleCode, sourceStationNumber)
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function normalizeAuthType(value: unknown): NonNullable<DicomServerConfig['orthanc_auth_type']> {
  return value === 'bearer' || value === 'basic' ? value : 'none'
}

function cleanDicomServerConfig(cfg: DicomServerConfig): DicomServerConfig {
  const authType = normalizeAuthType(cfg.orthanc_auth_type)
  return {
    orthanc_base_url: normalizeBaseUrl(cfg.orthanc_base_url),
    ohif_base_url: normalizeBaseUrl(cfg.ohif_base_url),
    orthanc_auth_type: authType,
    orthanc_auth_token: authType === 'bearer' ? cfg.orthanc_auth_token?.trim() || null : null,
    orthanc_auth_username: authType === 'basic' ? cfg.orthanc_auth_username?.trim() || null : null,
    orthanc_auth_password: authType === 'basic' ? cfg.orthanc_auth_password ?? null : null
  }
}

function orthancAuthHeaders(cfg: DicomServerConfig): Record<string, string> {
  const authType = normalizeAuthType(cfg.orthanc_auth_type)
  if (authType === 'bearer' && cfg.orthanc_auth_token?.trim()) {
    return { Authorization: `Bearer ${cfg.orthanc_auth_token.trim()}` }
  }
  if (authType === 'basic' && cfg.orthanc_auth_username) {
    const password = cfg.orthanc_auth_password ?? ''
    return {
      Authorization: `Basic ${Buffer.from(`${cfg.orthanc_auth_username}:${password}`).toString('base64')}`
    }
  }
  return {}
}

export function buildOhifStudyUrl(ohifBaseUrl: string, studyInstanceUid: string): string {
  return `${normalizeBaseUrl(ohifBaseUrl)}/viewer?StudyInstanceUIDs=${encodeURIComponent(studyInstanceUid)}`
}

function refreshStoredOhifUrls(db: Database.Database, ohifBaseUrl: string): void {
  const tables = [
    'dicom_study_links',
    'reference_dicom_links',
    'conclusion_dicom_links'
  ]

  for (const table of tables) {
    const rows = db
      .prepare(`SELECT rowid, study_instance_uid FROM ${table} WHERE study_instance_uid IS NOT NULL`)
      .all() as { rowid: number; study_instance_uid: string }[]
    const update = db.prepare(`UPDATE ${table} SET ohif_url = ? WHERE rowid = ?`)
    for (const row of rows) {
      update.run(buildOhifStudyUrl(ohifBaseUrl, row.study_instance_uid), row.rowid)
    }
  }
}

async function orthancGet<T>(cfg: DicomServerConfig, path: string): Promise<T> {
  const res = await fetch(`${normalizeBaseUrl(cfg.orthanc_base_url)}${path}`, {
    headers: orthancAuthHeaders(cfg)
  })
  if (!res.ok) {
    throw new Error(`Orthanc ${path} failed with HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

async function orthancGetBinary(
  cfg: DicomServerConfig,
  path: string
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await fetch(`${normalizeBaseUrl(cfg.orthanc_base_url)}${path}`, {
    headers: orthancAuthHeaders(cfg)
  })
  if (!res.ok) {
    throw new Error(`Orthanc ${path} failed with HTTP ${res.status}`)
  }
  return {
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get('content-type')?.split(';')[0] ?? 'image/png'
  }
}

async function orthancPostDicomFile(cfg: DicomServerConfig, filePath: string): Promise<void> {
  const bytes = readFileSync(filePath)
  const res = await fetch(`${normalizeBaseUrl(cfg.orthanc_base_url)}/instances`, {
    method: 'POST',
    headers: { ...orthancAuthHeaders(cfg), 'Content-Type': 'application/dicom' },
    body: new Uint8Array(bytes)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
  }
}

function collectUploadCandidateFiles(dirPath: string): string[] {
  const files: string[] = []

  function scan(dir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry === '.DS_Store') continue
      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        scan(fullPath)
      } else if (stat.isFile() && stat.size > 0) {
        files.push(fullPath)
      }
    }
  }

  scan(dirPath)
  files.sort((a, b) => a.localeCompare(b))
  return files
}

export async function uploadDicomFolderToOrthanc(
  cfg: DicomServerConfig,
  folderPath: string
): Promise<DicomUploadResult> {
  const files = collectUploadCandidateFiles(folderPath)
  const items: DicomUploadItem[] = []
  let uploaded = 0
  let skipped = 0
  let errors = 0

  for (const filePath of files) {
    try {
      await orthancPostDicomFile(cfg, filePath)
      uploaded++
      items.push({ path: filePath, status: 'uploaded' })
    } catch (err) {
      errors++
      items.push({ path: filePath, status: 'error', reason: String(err) })
    }
  }

  return {
    scanned: files.length,
    uploaded,
    skipped,
    errors,
    items
  }
}

export function prepareDicomExportFolder(
  db: Database.Database,
  folderPath: string
): DicomPreparedExportResult {
  return preparedExportResult(folderPath, scanPreparedExportGroups(db, folderPath))
}

function emptyDicomSyncResult(): DicomSyncResult {
  return {
    run_id: 0,
    studies_scanned: 0,
    matched: 0,
    unresolved: 0,
    errors: 0,
    links: [],
    reference_links: [],
    conclusion_links: [],
    unresolved_items: []
  }
}

export async function uploadPreparedDicomExportFolder(
  db: Database.Database,
  cfg: DicomServerConfig,
  folderPath: string,
  validGroupKeys: string[]
): Promise<DicomPreparedUploadResult> {
  const prepared = prepareDicomExportFolder(db, folderPath)
  const selectedKeys = new Set(validGroupKeys)
  const items: DicomPreparedUploadItem[] = []
  let uploaded = 0
  let copied = 0
  let skipped = 0
  let errors = 0
  let selectedDicomGroups = 0
  const tempRoot = mkdtempSync(join(tmpdir(), 'ultrasound-marker-dicom-'))

  try {
    for (const group of prepared.groups) {
      if (group.status !== 'valid') {
        skipped++
        items.push({
          group_key: group.key,
          status: 'skipped',
          reason: group.reason ?? 'Group is invalid.'
        })
        continue
      }
      if (!selectedKeys.has(group.key)) {
        skipped++
        items.push({
          group_key: group.key,
          status: 'skipped',
          reason: 'Group was not selected for upload.'
        })
        continue
      }

      selectedDicomGroups++
      const sourceFiles = collectFilesRecursive(group.folder_path)
      const validGroup = typedValidGroup(group, sourceFiles)

      let preparedPaths: string[]
      try {
        preparedPaths = prepareGroupDicomFiles(validGroup, tempRoot)
      } catch (err) {
        errors++
        items.push({
          group_key: group.key,
          status: 'error',
          reason: `DICOM preparation failed: ${getErrorMessage(err)}`
        })
        continue
      }

      for (const preparedPath of preparedPaths) {
        try {
          await orthancPostDicomFile(cfg, preparedPath)
          uploaded++
          items.push({
            group_key: group.key,
            path: preparedPath,
            status: 'uploaded'
          })
        } catch (err) {
          errors++
          items.push({
            group_key: group.key,
            path: preparedPath,
            status: 'error',
            reason: `Orthanc upload failed: ${getErrorMessage(err)}`
          })
        }
      }
    }

    const syncResult = selectedDicomGroups > 0 ? await syncDicomStudies(db, cfg) : emptyDicomSyncResult()
    return {
      prepared,
      scanned: prepared.groups.length,
      uploaded,
      copied,
      skipped,
      errors,
      items,
      sync_result: syncResult
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

export function getDicomServerConfig(db: Database.Database): DicomServerConfig | null {
  const row = db
    .prepare(`
      SELECT orthanc_base_url, ohif_base_url,
             orthanc_auth_type, orthanc_auth_token,
             orthanc_auth_username, orthanc_auth_password
      FROM dicom_server_config
      WHERE id = 1
    `)
    .get() as DicomServerConfig | undefined
  return row ? cleanDicomServerConfig(row) : null
}

export function saveDicomServerConfig(db: Database.Database, cfg: DicomServerConfig): DicomServerConfig {
  const clean = cleanDicomServerConfig(cfg)
  db.prepare(`
    INSERT INTO dicom_server_config
      (id, orthanc_base_url, ohif_base_url, orthanc_auth_type,
       orthanc_auth_token, orthanc_auth_username, orthanc_auth_password, configured_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      orthanc_base_url = excluded.orthanc_base_url,
      ohif_base_url = excluded.ohif_base_url,
      orthanc_auth_type = excluded.orthanc_auth_type,
      orthanc_auth_token = excluded.orthanc_auth_token,
      orthanc_auth_username = excluded.orthanc_auth_username,
      orthanc_auth_password = excluded.orthanc_auth_password,
      configured_at = excluded.configured_at
  `).run(
    clean.orthanc_base_url,
    clean.ohif_base_url,
    clean.orthanc_auth_type,
    clean.orthanc_auth_token,
    clean.orthanc_auth_username,
    clean.orthanc_auth_password,
    new Date().toISOString()
  )
  refreshStoredOhifUrls(db, clean.ohif_base_url)
  return clean
}

export async function testOrthancConnection(
  cfg: DicomServerConfig
): Promise<{ success: boolean; name?: string; version?: string; error?: string }> {
  try {
    const system = await orthancGet<Record<string, string>>(cfg, '/system')
    return {
      success: true,
      name: system.Name,
      version: system.Version
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

function insertUnresolved(
  db: Database.Database,
  runId: number | null,
  studyId: string | null,
  patientId: string | null,
  studyInstanceUid: string | null,
  reason: string,
  rawMetadata: unknown
): DicomUnresolvedStudy {
  const seenAt = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO dicom_unresolved_studies
      (run_id, orthanc_study_id, patient_id, study_instance_uid, reason, raw_metadata, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    studyId,
    patientId,
    studyInstanceUid,
    reason,
    rawMetadata === null || rawMetadata === undefined ? null : JSON.stringify(rawMetadata),
    seenAt
  )
  return {
    id: Number(result.lastInsertRowid),
    run_id: runId,
    orthanc_study_id: studyId,
    patient_id: patientId,
    study_instance_uid: studyInstanceUid,
    reason,
    raw_metadata: rawMetadata === null || rawMetadata === undefined ? null : JSON.stringify(rawMetadata),
    seen_at: seenAt
  }
}

function rowToStudyLink(row: unknown): DicomStudyLink {
  return row as DicomStudyLink
}

function rowToReferenceDicomLink(row: unknown): ReferenceDicomLink {
  return row as ReferenceDicomLink
}

function rowToConclusionDicomLink(row: unknown): ConclusionDicomLink {
  return row as ConclusionDicomLink
}

function getCurrentDicomLinkForStudy(
  db: Database.Database,
  orthancStudyId: string,
  studyInstanceUid: string | null
): DicomStudyLink | null {
  const row = studyInstanceUid
    ? db.prepare(`
        SELECT *
        FROM dicom_study_links
        WHERE study_instance_uid = ? OR orthanc_study_id = ?
        ORDER BY imported_at DESC, id DESC
        LIMIT 1
      `).get(studyInstanceUid, orthancStudyId)
    : db.prepare(`
        SELECT *
        FROM dicom_study_links
        WHERE orthanc_study_id = ?
        ORDER BY imported_at DESC, id DESC
        LIMIT 1
      `).get(orthancStudyId)
  return row ? rowToStudyLink(row) : null
}

function getUnresolvedForStudy(
  db: Database.Database,
  orthancStudyId: string,
  studyInstanceUid: string | null
): DicomUnresolvedStudy | null {
  const row = studyInstanceUid
    ? db.prepare(`
        SELECT *
        FROM dicom_unresolved_studies
        WHERE orthanc_study_id = ? OR study_instance_uid = ?
        ORDER BY seen_at DESC, id DESC
        LIMIT 1
      `).get(orthancStudyId, studyInstanceUid)
    : db.prepare(`
        SELECT *
        FROM dicom_unresolved_studies
        WHERE orthanc_study_id = ?
        ORDER BY seen_at DESC, id DESC
        LIMIT 1
      `).get(orthancStudyId)
  return (row as DicomUnresolvedStudy | undefined) ?? null
}

async function buildStudyCandidate(
  db: Database.Database,
  cfg: DicomServerConfig,
  studyId: string
): Promise<DicomStudyCandidate> {
  const study = await orthancGet<OrthancStudyDetails>(
    cfg,
    `/studies/${encodeURIComponent(studyId)}`
  )
  const patientId =
    study.PatientMainDicomTags?.PatientID ??
    study.MainDicomTags?.PatientID ??
    null
  const studyInstanceUid = study.MainDicomTags?.StudyInstanceUID ?? null
  const summary = await getStudySeriesSummary(cfg, study)

  return {
    orthanc_study_id: studyId,
    patient_id: patientId,
    study_instance_uid: studyInstanceUid,
    study_description: study.MainDicomTags?.StudyDescription ?? null,
    study_date: study.MainDicomTags?.StudyDate ?? null,
    modality: summary.modality,
    series_count: summary.seriesCount,
    instance_count: summary.instanceCount,
    current_link: getCurrentDicomLinkForStudy(db, studyId, studyInstanceUid),
    unresolved: getUnresolvedForStudy(db, studyId, studyInstanceUid)
  }
}

async function refreshLinkPreviewState(
  db: Database.Database,
  linkId: number
): Promise<DicomStudyLink | null> {
  const link = db.prepare('SELECT * FROM dicom_study_links WHERE id = ?').get(linkId) as DicomStudyLink | undefined
  if (!link) return null

  const checkedAt = new Date().toISOString()
  const result = await getDicomStudyPreviews(db, link.orthanc_study_id, 2)
  const previewCount = result.previews.filter((preview) => Boolean(preview.dataUrl)).length
  const previewError = result.error ?? (previewCount < 2 ? `Only ${previewCount} preview image(s) available.` : null)

  db.prepare(`
    UPDATE dicom_study_links
    SET preview_count = ?, preview_error = ?, preview_checked_at = ?
    WHERE id = ?
  `).run(previewCount, previewError, checkedAt, linkId)

  return rowToStudyLink(db.prepare('SELECT * FROM dicom_study_links WHERE id = ?').get(linkId))
}

async function getStudySeriesSummary(
  cfg: DicomServerConfig,
  study: OrthancStudyDetails
): Promise<{ seriesCount: number; instanceCount: number; modality: string | null }> {
  const seriesIds = study.Series ?? []
  let instanceCount = 0
  let modality: string | null = null

  for (const seriesId of seriesIds) {
    const series = await orthancGet<OrthancSeriesDetails>(cfg, `/series/${seriesId}`)
    instanceCount += series.Instances?.length ?? 0
    modality ??= series.MainDicomTags?.Modality ?? null
  }

  return { seriesCount: seriesIds.length, instanceCount, modality }
}

async function getInstanceFrameCount(cfg: DicomServerConfig, instanceId: string): Promise<number> {
  try {
    const tags = await orthancGet<Record<string, unknown>>(
      cfg,
      `/instances/${encodeURIComponent(instanceId)}/tags?simplify`
    )
    const numberOfFrames = tags.NumberOfFrames
    const parsed =
      typeof numberOfFrames === 'number'
        ? numberOfFrames
        : typeof numberOfFrames === 'string'
          ? Number.parseInt(numberOfFrames, 10)
          : 1
    return Number.isFinite(parsed) && parsed > 1 ? parsed : 1
  } catch {
    return 1
  }
}

export function getDicomLinksForStation(
  db: Database.Database,
  studentId: string,
  moduleCode: string,
  stationNumber: number
): DicomStudyLink[] {
  return db.prepare(`
    SELECT *
    FROM dicom_study_links
    WHERE student_id = ? AND module_code = ? AND station_number = ?
    ORDER BY imported_at DESC, id DESC
  `).all(studentId, moduleCode, stationNumber).map(rowToStudyLink)
}

export function getReferenceDicomLinks(
  db: Database.Database,
  moduleCode: string,
  stationNumber: number
): ReferenceDicomLink[] {
  const profileId = getActiveProfileId(db)
  return db.prepare(`
    SELECT *
    FROM reference_dicom_links
    WHERE profile_id = ? AND module_code = ? AND station_number = ?
    ORDER BY slot
  `).all(profileId, moduleCode, stationNumber).map(rowToReferenceDicomLink)
}

export function getConclusionDicomLink(
  db: Database.Database,
  studentId: string,
  moduleCode: string,
  stationNumber: number
): ConclusionDicomLink | null {
  const profileId = getActiveProfileId(db)
  const row = db.prepare(`
    SELECT *
    FROM conclusion_dicom_links
    WHERE profile_id = ? AND student_id = ? AND module_code = ? AND station_number = ?
    LIMIT 1
  `).get(profileId, studentId, moduleCode, stationNumber)
  return row ? rowToConclusionDicomLink(row) : null
}

export async function getDicomStudyPreview(
  db: Database.Database,
  orthancStudyId: string
): Promise<DicomStudyPreview> {
  const result = await getDicomStudyPreviews(db, orthancStudyId, 1)
  return result.previews[0] ?? {
    dataUrl: null,
    orthanc_study_id: orthancStudyId,
    orthanc_instance_id: null,
    content_type: null,
    image_index: 1,
    error: result.error ?? 'No previewable DICOM instances were found in this study.'
  }
}

export async function getDicomStudyPreviews(
  db: Database.Database,
  orthancStudyId: string,
  limit = 2
): Promise<DicomStudyPreviews> {
  const cfg = getDicomServerConfig(db)
  if (!cfg) {
    return {
      orthanc_study_id: orthancStudyId,
      previews: [],
      error: 'DICOM server is not configured.'
    }
  }

  try {
    const study = await orthancGet<OrthancStudyDetails>(
      cfg,
      `/studies/${encodeURIComponent(orthancStudyId)}`
    )

    const previews: DicomStudyPreview[] = []
    const errors: string[] = []

    for (const seriesId of study.Series ?? []) {
      const series = await orthancGet<OrthancSeriesDetails>(
        cfg,
        `/series/${encodeURIComponent(seriesId)}`
      )

      for (const instanceId of series.Instances ?? []) {
        const frameCount = await getInstanceFrameCount(cfg, instanceId)
        const previewTargets =
          frameCount > 1
            ? Array.from({ length: frameCount }, (_, frameIndex) => ({
                path: `/instances/${encodeURIComponent(instanceId)}/frames/${frameIndex}/preview`,
                frameIndex
              }))
            : [{ path: `/instances/${encodeURIComponent(instanceId)}/preview`, frameIndex: null }]

        for (const target of previewTargets) {
          if (previews.length >= limit) {
            return { orthanc_study_id: orthancStudyId, previews }
          }

          try {
            const preview = await orthancGetBinary(cfg, target.path)
            const base64 = Buffer.from(preview.bytes).toString('base64')
            previews.push({
              dataUrl: `data:${preview.contentType};base64,${base64}`,
              orthanc_study_id: orthancStudyId,
              orthanc_instance_id: instanceId,
              orthanc_frame_index: target.frameIndex,
              content_type: preview.contentType,
              image_index: previews.length + 1
            })
          } catch (err) {
            errors.push(String(err))
          }
        }

        try {
          if (frameCount > 1 && previews.length === 0) {
            const preview = await orthancGetBinary(
              cfg,
              `/instances/${encodeURIComponent(instanceId)}/preview`
            )
            const base64 = Buffer.from(preview.bytes).toString('base64')
            previews.push({
              dataUrl: `data:${preview.contentType};base64,${base64}`,
              orthanc_study_id: orthancStudyId,
              orthanc_instance_id: instanceId,
              orthanc_frame_index: null,
              content_type: preview.contentType,
              image_index: previews.length + 1
            })
          }
        } catch (err) {
          errors.push(String(err))
        }
      }
    }

    return {
      orthanc_study_id: orthancStudyId,
      previews,
      error: previews.length > 0
        ? undefined
        : errors[0] ?? 'No previewable DICOM instances were found in this study.'
    }
  } catch (err) {
    return {
      orthanc_study_id: orthancStudyId,
      previews: [],
      error: String(err)
    }
  }
}

export function getRecentDicomUnresolved(
  db: Database.Database,
  limit = 100
): DicomUnresolvedStudy[] {
  return db.prepare(`
    SELECT *
    FROM dicom_unresolved_studies
    ORDER BY seen_at DESC, id DESC
    LIMIT ?
  `).all(limit) as DicomUnresolvedStudy[]
}

export async function getDicomStudyCandidates(
  db: Database.Database,
  limit = 500,
  query = ''
): Promise<DicomStudyCandidate[]> {
  const cfg = getDicomServerConfig(db)
  if (!cfg) throw new Error('DICOM server is not configured.')

  const studyIds = await orthancGet<string[]>(cfg, '/studies')
  const q = query.trim().toLowerCase()
  const candidates: DicomStudyCandidate[] = []

  for (const studyId of studyIds) {
    if (candidates.length >= limit) break
    try {
      const candidate = await buildStudyCandidate(db, cfg, studyId)
      if (q) {
        const haystack = [
          candidate.patient_id,
          candidate.study_instance_uid,
          candidate.study_description,
          candidate.orthanc_study_id,
          candidate.current_link?.student_id,
          candidate.current_link?.module_code,
          candidate.current_link ? `stn ${candidate.current_link.station_number}` : null,
          candidate.unresolved?.reason
        ].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(q)) continue
      }
      candidates.push(candidate)
    } catch {
      // Ignore individual Orthanc studies that cannot be inspected.
    }
  }

  candidates.sort((a, b) => {
    const aLinked = a.current_link ? 1 : 0
    const bLinked = b.current_link ? 1 : 0
    if (aLinked !== bLinked) return aLinked - bLinked
    return (a.patient_id ?? '').localeCompare(b.patient_id ?? '')
  })
  return candidates
}

export async function getDicomStudyCandidateDetails(
  db: Database.Database,
  orthancStudyId: string
): Promise<DicomStudyCandidateDetails> {
  const cfg = getDicomServerConfig(db)
  if (!cfg) throw new Error('DICOM server is not configured.')
  const candidate = await buildStudyCandidate(db, cfg, orthancStudyId)
  const previewResult = await getDicomStudyPreviews(db, orthancStudyId, 2)
  return {
    ...candidate,
    previews: previewResult.previews,
    error: previewResult.error
  }
}

export async function getDicomUnresolvedStudyDetails(
  db: Database.Database,
  unresolvedId: number
): Promise<DicomUnresolvedStudyDetails | null> {
  const unresolved = db
    .prepare('SELECT * FROM dicom_unresolved_studies WHERE id = ?')
    .get(unresolvedId) as DicomUnresolvedStudy | undefined
  if (!unresolved) return null

  let studyDescription: string | null = null
  let studyDate: string | null = null
  let modality: string | null = null
  let seriesCount: number | null = null
  let instanceCount: number | null = null

  if (unresolved.orthanc_study_id) {
    const cfg = getDicomServerConfig(db)
    if (cfg) {
      try {
        const study = await orthancGet<OrthancStudyDetails>(
          cfg,
          `/studies/${encodeURIComponent(unresolved.orthanc_study_id)}`
        )
        const summary = await getStudySeriesSummary(cfg, study)
        studyDescription = study.MainDicomTags?.StudyDescription ?? null
        studyDate = study.MainDicomTags?.StudyDate ?? null
        modality = summary.modality
        seriesCount = summary.seriesCount
        instanceCount = summary.instanceCount
      } catch {
        // Preview retrieval below will surface a usable error for the resolver.
      }
    }
  }

  const previewResult = unresolved.orthanc_study_id
    ? await getDicomStudyPreviews(db, unresolved.orthanc_study_id, 2)
    : { orthanc_study_id: '', previews: [], error: 'This unresolved item has no Orthanc study ID.' }

  return {
    unresolved,
    previews: previewResult.previews,
    error: previewResult.error,
    study_description: studyDescription,
    study_date: studyDate,
    modality,
    series_count: seriesCount,
    instance_count: instanceCount
  }
}

export async function refreshDicomLinkPreviewState(
  db: Database.Database,
  linkId: number
): Promise<DicomStudyLink | null> {
  return refreshLinkPreviewState(db, linkId)
}

export async function linkDicomStudyToStation(
  db: Database.Database,
  orthancStudyId: string,
  studentId: string,
  moduleCode: string,
  stationNumber: number,
  moveExisting: boolean
): Promise<DicomManualLinkResult> {
  const cfg = getDicomServerConfig(db)
  if (!cfg) return { success: false, error: 'DICOM server is not configured.' }

  const profileId = getActiveProfileId(db)
  const student = db.prepare(`
    SELECT ps.student_id
    FROM profile_students ps
    JOIN student_enrollments se
      ON se.profile_id = ps.profile_id
     AND se.student_id = ps.student_id
    WHERE ps.profile_id = ? AND ps.student_id = ? AND se.module_code = ?
  `).get(profileId, studentId, moduleCode) as { student_id: string } | undefined
  if (!student) {
    return { success: false, error: 'Target student/module was not found in the active profile.' }
  }

  const station = db.prepare(`
    SELECT 1
    FROM assessment_stations
    WHERE profile_id = ? AND module_code = ? AND station_number = ?
    LIMIT 1
  `).get(profileId, moduleCode, stationNumber)
  if (!station) {
    return { success: false, error: 'Target station was not found in the active profile.' }
  }

  let study: OrthancStudyDetails
  try {
    study = await orthancGet<OrthancStudyDetails>(
      cfg,
      `/studies/${encodeURIComponent(orthancStudyId)}`
    )
  } catch (err) {
    return { success: false, error: `Failed to inspect Orthanc study: ${String(err)}` }
  }

  const studyInstanceUid = study.MainDicomTags?.StudyInstanceUID ?? null
  if (!studyInstanceUid) {
    return { success: false, error: 'StudyInstanceUID is missing; this study cannot be linked.' }
  }

  const duplicate = getCurrentDicomLinkForStudy(db, orthancStudyId, studyInstanceUid)
  if (duplicate) {
    const sameTarget =
      duplicate.student_id === studentId &&
      duplicate.module_code === moduleCode &&
      duplicate.station_number === stationNumber
    if (sameTarget) {
      return { success: true, link: duplicate }
    }
  }

  const summary = await getStudySeriesSummary(cfg, study)
  const previewResult = await getDicomStudyPreviews(db, orthancStudyId, 2)
  const previewCount = previewResult.previews.filter((preview) => Boolean(preview.dataUrl)).length
  const previewError = previewResult.error ?? (previewCount < 2 ? `Only ${previewCount} preview image(s) available.` : null)
  const importedAt = new Date().toISOString()
  const patientId =
    study.PatientMainDicomTags?.PatientID ??
    study.MainDicomTags?.PatientID ??
    'UNKNOWN'

  const result = db.prepare(`
    INSERT INTO dicom_study_links
      (student_id, student_short_id, module_code, station_number, patient_id,
       study_instance_uid, orthanc_study_id, study_description, study_date, modality,
       series_count, instance_count, ohif_url, imported_at, preview_count,
       preview_error, preview_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, module_code, station_number, study_instance_uid)
    DO UPDATE SET
      student_short_id = excluded.student_short_id,
      patient_id = excluded.patient_id,
      orthanc_study_id = excluded.orthanc_study_id,
      study_description = excluded.study_description,
      study_date = excluded.study_date,
      modality = excluded.modality,
      series_count = excluded.series_count,
      instance_count = excluded.instance_count,
      ohif_url = excluded.ohif_url,
      imported_at = excluded.imported_at,
      preview_count = excluded.preview_count,
      preview_error = excluded.preview_error,
      preview_checked_at = excluded.preview_checked_at
  `).run(
    studentId,
    studentId.slice(-6),
    moduleCode,
    stationNumber,
    patientId,
    studyInstanceUid,
    orthancStudyId,
    study.MainDicomTags?.StudyDescription ?? null,
    study.MainDicomTags?.StudyDate ?? null,
    summary.modality,
    summary.seriesCount,
    summary.instanceCount,
    buildOhifStudyUrl(cfg.ohif_base_url, studyInstanceUid),
    importedAt,
    previewCount,
    previewError,
    importedAt
  )

  db.prepare(`
    DELETE FROM dicom_unresolved_studies
    WHERE orthanc_study_id = ? OR study_instance_uid = ?
  `).run(orthancStudyId, studyInstanceUid)

  const link = rowToStudyLink(
    db.prepare('SELECT * FROM dicom_study_links WHERE id = ?').get(Number(result.lastInsertRowid))
  )
  return { success: true, link }
}

export async function linkReferenceDicomStudy(
  db: Database.Database,
  orthancStudyId: string,
  moduleCode: string,
  stationNumber: number,
  slot: 1 | 2
): Promise<ReferenceDicomLinkResult> {
  const cfg = getDicomServerConfig(db)
  if (!cfg) return { success: false, error: 'DICOM server is not configured.' }
  if (slot !== 1 && slot !== 2) {
    return { success: false, error: 'Reference slot must be REF 1 or REF 2.' }
  }

  const profileId = getActiveProfileId(db)
  const station = db.prepare(`
    SELECT 1
    FROM assessment_stations
    WHERE profile_id = ? AND module_code = ? AND station_number = ?
    LIMIT 1
  `).get(profileId, moduleCode, stationNumber)
  if (!station) {
    return { success: false, error: 'Target reference station was not found in the active profile.' }
  }

  let study: OrthancStudyDetails
  try {
    study = await orthancGet<OrthancStudyDetails>(
      cfg,
      `/studies/${encodeURIComponent(orthancStudyId)}`
    )
  } catch (err) {
    return { success: false, error: `Failed to inspect Orthanc study: ${String(err)}` }
  }

  const studyInstanceUid = study.MainDicomTags?.StudyInstanceUID ?? null
  if (!studyInstanceUid) {
    return { success: false, error: 'StudyInstanceUID is missing; this study cannot be linked.' }
  }

  const summary = await getStudySeriesSummary(cfg, study)
  const previewResult = await getDicomStudyPreviews(db, orthancStudyId, 1)
  const previewCount = previewResult.previews.filter((preview) => Boolean(preview.dataUrl)).length
  const previewError = previewResult.error ?? (previewCount < 1 ? 'No preview image is available.' : null)
  const linkedAt = new Date().toISOString()
  const patientId =
    study.PatientMainDicomTags?.PatientID ??
    study.MainDicomTags?.PatientID ??
    'UNKNOWN'

  db.prepare(`
    INSERT INTO reference_dicom_links
      (profile_id, module_code, station_number, slot, patient_id,
       study_instance_uid, orthanc_study_id, study_description, study_date,
       modality, series_count, instance_count, ohif_url, linked_at,
       preview_count, preview_error, preview_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, module_code, station_number, slot)
    DO UPDATE SET
      patient_id = excluded.patient_id,
      study_instance_uid = excluded.study_instance_uid,
      orthanc_study_id = excluded.orthanc_study_id,
      study_description = excluded.study_description,
      study_date = excluded.study_date,
      modality = excluded.modality,
      series_count = excluded.series_count,
      instance_count = excluded.instance_count,
      ohif_url = excluded.ohif_url,
      linked_at = excluded.linked_at,
      preview_count = excluded.preview_count,
      preview_error = excluded.preview_error,
      preview_checked_at = excluded.preview_checked_at
  `).run(
    profileId,
    moduleCode,
    stationNumber,
    slot,
    patientId,
    studyInstanceUid,
    orthancStudyId,
    study.MainDicomTags?.StudyDescription ?? null,
    study.MainDicomTags?.StudyDate ?? null,
    summary.modality,
    summary.seriesCount,
    summary.instanceCount,
    buildOhifStudyUrl(cfg.ohif_base_url, studyInstanceUid),
    linkedAt,
    previewCount,
    previewError,
    linkedAt
  )

  db.prepare(`
    DELETE FROM dicom_unresolved_studies
    WHERE orthanc_study_id = ? OR study_instance_uid = ?
  `).run(orthancStudyId, studyInstanceUid)

  const link = rowToReferenceDicomLink(db.prepare(`
    SELECT *
    FROM reference_dicom_links
    WHERE profile_id = ? AND module_code = ? AND station_number = ? AND slot = ?
  `).get(profileId, moduleCode, stationNumber, slot))
  return { success: true, link }
}

export function unlinkReferenceDicomStudy(
  db: Database.Database,
  moduleCode: string,
  stationNumber: number,
  slot: 1 | 2
): ReferenceDicomLinkResult {
  const profileId = getActiveProfileId(db)
  const result = db.prepare(`
    DELETE FROM reference_dicom_links
    WHERE profile_id = ? AND module_code = ? AND station_number = ? AND slot = ?
  `).run(profileId, moduleCode, stationNumber, slot)
  if (result.changes === 0) return { success: false, error: 'Reference DICOM link was not found.' }
  return { success: true }
}

async function upsertConclusionDicomLinkFromStudy(
  db: Database.Database,
  cfg: DicomServerConfig,
  study: OrthancStudyDetails,
  orthancStudyId: string,
  studentId: string,
  studentShortId: string,
  moduleCode: string,
  stationNumber: number,
  patientId: string,
  studyInstanceUid: string
): Promise<ConclusionDicomLink> {
  const profileId = getActiveProfileId(db)
  const summary = await getStudySeriesSummary(cfg, study)
  const previewResult = await getDicomStudyPreviews(db, orthancStudyId, 1)
  const previewCount = previewResult.previews.filter((preview) => Boolean(preview.dataUrl)).length
  const previewError = previewResult.error ?? (previewCount < 1 ? 'No preview image is available.' : null)
  const linkedAt = new Date().toISOString()

  db.prepare(`
    INSERT INTO conclusion_dicom_links
      (profile_id, student_id, student_short_id, module_code, station_number,
       patient_id, study_instance_uid, orthanc_study_id, study_description,
       study_date, modality, series_count, instance_count, ohif_url,
       linked_at, preview_count, preview_error, preview_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, student_id, module_code, station_number)
    DO UPDATE SET
      student_short_id = excluded.student_short_id,
      patient_id = excluded.patient_id,
      study_instance_uid = excluded.study_instance_uid,
      orthanc_study_id = excluded.orthanc_study_id,
      study_description = excluded.study_description,
      study_date = excluded.study_date,
      modality = excluded.modality,
      series_count = excluded.series_count,
      instance_count = excluded.instance_count,
      ohif_url = excluded.ohif_url,
      linked_at = excluded.linked_at,
      preview_count = excluded.preview_count,
      preview_error = excluded.preview_error,
      preview_checked_at = excluded.preview_checked_at
  `).run(
    profileId,
    studentId,
    studentShortId,
    moduleCode,
    stationNumber,
    patientId,
    studyInstanceUid,
    orthancStudyId,
    study.MainDicomTags?.StudyDescription ?? null,
    study.MainDicomTags?.StudyDate ?? null,
    summary.modality,
    summary.seriesCount,
    summary.instanceCount,
    buildOhifStudyUrl(cfg.ohif_base_url, studyInstanceUid),
    linkedAt,
    previewCount,
    previewError,
    linkedAt
  )

  db.prepare(`
    DELETE FROM dicom_unresolved_studies
    WHERE orthanc_study_id = ? OR study_instance_uid = ?
  `).run(orthancStudyId, studyInstanceUid)

  return rowToConclusionDicomLink(db.prepare(`
    SELECT *
    FROM conclusion_dicom_links
    WHERE profile_id = ? AND student_id = ? AND module_code = ? AND station_number = ?
  `).get(profileId, studentId, moduleCode, stationNumber))
}

export async function linkConclusionDicomStudy(
  db: Database.Database,
  orthancStudyId: string,
  studentId: string,
  moduleCode: string,
  stationNumber: number
): Promise<ConclusionDicomLinkResult> {
  const cfg = getDicomServerConfig(db)
  if (!cfg) return { success: false, error: 'DICOM server is not configured.' }
  const profileId = getActiveProfileId(db)

  const student = db.prepare(`
    SELECT ps.student_id
    FROM profile_students ps
    JOIN student_enrollments se
      ON se.profile_id = ps.profile_id
     AND se.student_id = ps.student_id
    WHERE ps.profile_id = ? AND ps.student_id = ? AND se.module_code = ?
    LIMIT 1
  `).get(profileId, studentId, moduleCode) as { student_id: string } | undefined
  if (!student) return { success: false, error: 'Target student/module was not found in the active profile.' }

  const station = db.prepare(`
    SELECT 1
    FROM station_form_fields
    WHERE profile_id = ? AND module_code = ? AND station_number = ?
      AND upper(field_id) LIKE '%CONCLUSION%'
    LIMIT 1
  `).get(profileId, moduleCode, stationNumber)
  if (!station) return { success: false, error: 'Target station is not configured to require a conclusion.' }

  let study: OrthancStudyDetails
  try {
    study = await orthancGet<OrthancStudyDetails>(
      cfg,
      `/studies/${encodeURIComponent(orthancStudyId)}`
    )
  } catch (err) {
    return { success: false, error: `Failed to inspect Orthanc study: ${String(err)}` }
  }

  const studyInstanceUid = study.MainDicomTags?.StudyInstanceUID ?? null
  if (!studyInstanceUid) return { success: false, error: 'StudyInstanceUID is missing; this study cannot be linked.' }

  const patientId =
    study.PatientMainDicomTags?.PatientID ??
    study.MainDicomTags?.PatientID ??
    'UNKNOWN'
  const link = await upsertConclusionDicomLinkFromStudy(
    db,
    cfg,
    study,
    orthancStudyId,
    studentId,
    studentId.slice(-6),
    moduleCode,
    stationNumber,
    patientId,
    studyInstanceUid
  )
  return { success: true, link }
}

export function unlinkConclusionDicomStudy(
  db: Database.Database,
  studentId: string,
  moduleCode: string,
  stationNumber: number
): ConclusionDicomLinkResult {
  const profileId = getActiveProfileId(db)
  const result = db.prepare(`
    DELETE FROM conclusion_dicom_links
    WHERE profile_id = ? AND student_id = ? AND module_code = ? AND station_number = ?
  `).run(profileId, studentId, moduleCode, stationNumber)
  if (result.changes === 0) return { success: false, error: 'Conclusion DICOM link was not found.' }
  return { success: true }
}

export async function linkUnresolvedDicomStudyToStation(
  db: Database.Database,
  unresolvedId: number,
  studentId: string,
  moduleCode: string,
  stationNumber: number
): Promise<DicomManualLinkResult> {
  const unresolved = db
    .prepare('SELECT * FROM dicom_unresolved_studies WHERE id = ?')
    .get(unresolvedId) as DicomUnresolvedStudy | undefined
  if (!unresolved) return { success: false, error: 'Unresolved DICOM study was not found.' }
  if (!unresolved.orthanc_study_id) {
    return { success: false, error: 'This unresolved item has no Orthanc study ID to link.' }
  }
  return linkDicomStudyToStation(db, unresolved.orthanc_study_id, studentId, moduleCode, stationNumber, false)
}

export function unlinkDicomStudyLink(
  db: Database.Database,
  linkId: number,
  restoreUnresolved: boolean
): DicomUnlinkResult {
  const link = db.prepare('SELECT * FROM dicom_study_links WHERE id = ?').get(linkId) as DicomStudyLink | undefined
  if (!link) return { success: false, error: 'DICOM link was not found.' }

  db.prepare('DELETE FROM dicom_study_links WHERE id = ?').run(linkId)

  if (!restoreUnresolved) return { success: true }

  const restored = insertUnresolved(
    db,
    null,
    link.orthanc_study_id,
    link.patient_id,
    link.study_instance_uid,
    `Manually unlinked from ${link.student_id} ${link.module_code} Stn ${link.station_number}`,
    {
      study_description: link.study_description,
      study_date: link.study_date,
      modality: link.modality,
      series_count: link.series_count,
      instance_count: link.instance_count
    }
  )

  return { success: true, restored_unresolved: restored }
}

async function upsertReferenceDicomLinksFromStudy(
  db: Database.Database,
  cfg: DicomServerConfig,
  study: OrthancStudyDetails,
  orthancStudyId: string,
  moduleCode: string,
  stationNumber: number,
  patientId: string,
  studyInstanceUid: string
): Promise<ReferenceDicomLink[]> {
  const profileId = getActiveProfileId(db)
  const summary = await getStudySeriesSummary(cfg, study)
  const previewResult = await getDicomStudyPreviews(db, orthancStudyId, 2)
  const previewCount = previewResult.previews.filter((preview) => Boolean(preview.dataUrl)).length
  const previewError = previewResult.error ?? (previewCount < 1 ? 'No preview image is available.' : null)
  const linkedAt = new Date().toISOString()
  const slots: Array<1 | 2> = previewCount >= 2 ? [1, 2] : [1]

  for (const slot of slots) {
    db.prepare(`
      INSERT INTO reference_dicom_links
        (profile_id, module_code, station_number, slot, patient_id,
         study_instance_uid, orthanc_study_id, study_description, study_date,
         modality, series_count, instance_count, ohif_url, linked_at,
         preview_count, preview_error, preview_checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, module_code, station_number, slot)
      DO UPDATE SET
        patient_id = excluded.patient_id,
        study_instance_uid = excluded.study_instance_uid,
        orthanc_study_id = excluded.orthanc_study_id,
        study_description = excluded.study_description,
        study_date = excluded.study_date,
        modality = excluded.modality,
        series_count = excluded.series_count,
        instance_count = excluded.instance_count,
        ohif_url = excluded.ohif_url,
        linked_at = excluded.linked_at,
        preview_count = excluded.preview_count,
        preview_error = excluded.preview_error,
        preview_checked_at = excluded.preview_checked_at
    `).run(
      profileId,
      moduleCode,
      stationNumber,
      slot,
      patientId,
      studyInstanceUid,
      orthancStudyId,
      study.MainDicomTags?.StudyDescription ?? null,
      study.MainDicomTags?.StudyDate ?? null,
      summary.modality,
      summary.seriesCount,
      summary.instanceCount,
      buildOhifStudyUrl(cfg.ohif_base_url, studyInstanceUid),
      linkedAt,
      previewCount,
      previewError,
      linkedAt
    )
  }

  db.prepare(`
    DELETE FROM dicom_unresolved_studies
    WHERE orthanc_study_id = ? OR study_instance_uid = ?
  `).run(orthancStudyId, studyInstanceUid)

  return db.prepare(`
    SELECT *
    FROM reference_dicom_links
    WHERE profile_id = ?
      AND module_code = ?
      AND station_number = ?
      AND study_instance_uid = ?
    ORDER BY slot
  `).all(profileId, moduleCode, stationNumber, studyInstanceUid).map(rowToReferenceDicomLink)
}

export async function syncDicomStudies(
  db: Database.Database,
  cfg: DicomServerConfig
): Promise<DicomSyncResult> {
  const cleanCfg = saveDicomServerConfig(db, cfg)
  const runAt = new Date().toISOString()
  const runResult = db.prepare(`
    INSERT INTO dicom_import_runs
      (run_at, orthanc_base_url, ohif_base_url, studies_scanned, matched, unresolved, errors)
    VALUES (?, ?, ?, 0, 0, 0, 0)
  `).run(runAt, cleanCfg.orthanc_base_url, cleanCfg.ohif_base_url)
  const runId = Number(runResult.lastInsertRowid)

  const importedLinks: DicomStudyLink[] = []
  const importedReferenceLinks: ReferenceDicomLink[] = []
  const importedConclusionLinks: ConclusionDicomLink[] = []
  const unresolvedItems: DicomUnresolvedStudy[] = []
  let matchedStudies = 0
  let studiesScanned = 0
  let errors = 0

  try {
    const studyIds = await orthancGet<string[]>(cleanCfg, '/studies')
    studiesScanned = studyIds.length

    for (const studyId of studyIds) {
      try {
        const study = await orthancGet<OrthancStudyDetails>(cleanCfg, `/studies/${studyId}`)
        const patientId =
          study.PatientMainDicomTags?.PatientID ??
          study.MainDicomTags?.PatientID ??
          null
        const studyInstanceUid = study.MainDicomTags?.StudyInstanceUID ?? null
        const parsed = parseDicomPatientId(
          patientId,
          (value) => resolveModuleAlias(db, value),
          (moduleCode, sourceStationNumber) => resolveDicomStationNumber(db, moduleCode, sourceStationNumber)
        )
        const parsedReference = parseReferenceDicomPatientId(
          patientId,
          (value) => resolveModuleAlias(db, value),
          (moduleCode, sourceStationNumber) => resolveDicomStationNumber(db, moduleCode, sourceStationNumber)
        )
        const parsedConclusion = parseConclusionDicomPatientId(
          patientId,
          (value) => resolveModuleAlias(db, value),
          (moduleCode, sourceStationNumber) => resolveDicomStationNumber(db, moduleCode, sourceStationNumber)
        )

        if (!parsed && !parsedReference && !parsedConclusion) {
          unresolvedItems.push(
            insertUnresolved(db, runId, studyId, patientId, studyInstanceUid, 'PatientID does not match ShortID-MODULE-STATION, ShortID-MODULE-STATIONc, or REF-MODULE-STATION', {
              PatientID: patientId,
              MainDicomTags: study.MainDicomTags,
              PatientMainDicomTags: study.PatientMainDicomTags
            })
          )
          continue
        }

        if (!studyInstanceUid) {
          unresolvedItems.push(
            insertUnresolved(db, runId, studyId, patientId, null, 'StudyInstanceUID is missing', study)
          )
          continue
        }

        if (parsedConclusion) {
          const student = getStudentByShortId(db, parsedConclusion.student_short_id, parsedConclusion.module_code)
          if (!student) {
            unresolvedItems.push(
              insertUnresolved(
                db,
                runId,
                studyId,
                patientId,
                studyInstanceUid,
                `No imported student matches short ID ${parsedConclusion.student_short_id} in module ${parsedConclusion.module_code}`,
                study
              )
            )
            continue
          }

          if (!hasActiveProfileStation(db, parsedConclusion.module_code, parsedConclusion.station_number)) {
            const stationReason = parsedConclusion.source_station_number === parsedConclusion.station_number
              ? `Station ${parsedConclusion.station_number} is not configured for module ${parsedConclusion.module_code}`
              : `Source station ${parsedConclusion.source_station_number} maps to Station ${parsedConclusion.station_number}, which is not configured for module ${parsedConclusion.module_code}`
            unresolvedItems.push(
              insertUnresolved(db, runId, studyId, patientId, studyInstanceUid, stationReason, study)
            )
            continue
          }

          if (!activeProfileStationRequiresConclusion(db, parsedConclusion.module_code, parsedConclusion.station_number)) {
            unresolvedItems.push(
              insertUnresolved(
                db,
                runId,
                studyId,
                patientId,
                studyInstanceUid,
                `Station ${parsedConclusion.station_number} in module ${parsedConclusion.module_code} is not configured to require a conclusion`,
                study
              )
            )
            continue
          }

          const link = await upsertConclusionDicomLinkFromStudy(
            db,
            cleanCfg,
            study,
            studyId,
            student.student_id,
            parsedConclusion.student_short_id,
            parsedConclusion.module_code,
            parsedConclusion.station_number,
            patientId ?? makeConclusionPatientId(
              parsedConclusion.student_short_id,
              parsedConclusion.module_code,
              parsedConclusion.source_station_number
            ),
            studyInstanceUid
          )
          importedConclusionLinks.push(link)
          matchedStudies++
          continue
        }

        if (parsedReference) {
          if (!hasActiveProfileStation(db, parsedReference.module_code, parsedReference.station_number)) {
            const stationReason = parsedReference.source_station_number === parsedReference.station_number
              ? `Reference station ${parsedReference.station_number} is not configured for module ${parsedReference.module_code}`
              : `Reference source station ${parsedReference.source_station_number} maps to Station ${parsedReference.station_number}, which is not configured for module ${parsedReference.module_code}`
            unresolvedItems.push(
              insertUnresolved(
                db,
                runId,
                studyId,
                patientId,
                studyInstanceUid,
                stationReason,
                study
              )
            )
            continue
          }

          const links = await upsertReferenceDicomLinksFromStudy(
            db,
            cleanCfg,
            study,
            studyId,
            parsedReference.module_code,
            parsedReference.station_number,
            patientId ?? makeReferencePatientId(parsedReference.module_code, parsedReference.source_station_number),
            studyInstanceUid
          )
          importedReferenceLinks.push(...links)
          matchedStudies++
          continue
        }

        if (!parsed) continue

        const student = getStudentByShortId(db, parsed.student_short_id, parsed.module_code)
        if (!student) {
          unresolvedItems.push(
            insertUnresolved(
              db,
              runId,
              studyId,
              patientId,
              studyInstanceUid,
              `No imported student matches short ID ${parsed.student_short_id} in module ${parsed.module_code}`,
              study
            )
          )
          continue
        }

        if (!hasActiveProfileStation(db, parsed.module_code, parsed.station_number)) {
          const stationReason = parsed.source_station_number === parsed.station_number
            ? `Station ${parsed.station_number} is not configured for module ${parsed.module_code}`
            : `Source station ${parsed.source_station_number} maps to Station ${parsed.station_number}, which is not configured for module ${parsed.module_code}`
          unresolvedItems.push(
            insertUnresolved(
              db,
              runId,
              studyId,
              patientId,
              studyInstanceUid,
              stationReason,
              study
            )
          )
          continue
        }

        const summary = await getStudySeriesSummary(cleanCfg, study)
        const ohifUrl = buildOhifStudyUrl(cleanCfg.ohif_base_url, studyInstanceUid)
        const importedAt = new Date().toISOString()

        db.prepare(`
          DELETE FROM dicom_study_links
          WHERE (study_instance_uid = ? OR orthanc_study_id = ?)
            AND NOT (student_id = ? AND module_code = ? AND station_number = ?)
        `).run(
          studyInstanceUid,
          studyId,
          student.student_id,
          parsed.module_code,
          parsed.station_number
        )

        db.prepare(`
          INSERT INTO dicom_study_links
            (student_id, student_short_id, module_code, station_number, patient_id,
             study_instance_uid, orthanc_study_id, study_description, study_date, modality,
             series_count, instance_count, ohif_url, imported_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(student_id, module_code, station_number, study_instance_uid)
          DO UPDATE SET
            patient_id = excluded.patient_id,
            orthanc_study_id = excluded.orthanc_study_id,
            study_description = excluded.study_description,
            study_date = excluded.study_date,
            modality = excluded.modality,
            series_count = excluded.series_count,
            instance_count = excluded.instance_count,
            ohif_url = excluded.ohif_url,
            imported_at = excluded.imported_at
        `).run(
          student.student_id,
          parsed.student_short_id,
          parsed.module_code,
          parsed.station_number,
          patientId,
          studyInstanceUid,
          studyId,
          study.MainDicomTags?.StudyDescription ?? null,
          study.MainDicomTags?.StudyDate ?? null,
          summary.modality,
          summary.seriesCount,
          summary.instanceCount,
          ohifUrl,
          importedAt
        )

        const row = db.prepare(`
          SELECT *
          FROM dicom_study_links
          WHERE student_id = ? AND module_code = ? AND station_number = ? AND study_instance_uid = ?
        `).get(student.student_id, parsed.module_code, parsed.station_number, studyInstanceUid)
        importedLinks.push(rowToStudyLink(row))
        matchedStudies++
        db.prepare(`
          DELETE FROM dicom_unresolved_studies
          WHERE orthanc_study_id = ? OR study_instance_uid = ?
        `).run(studyId, studyInstanceUid)
      } catch (err) {
        errors++
        unresolvedItems.push(
          insertUnresolved(db, runId, studyId, null, null, `Failed to inspect study: ${String(err)}`, null)
        )
      }
    }
  } catch (err) {
    errors++
    unresolvedItems.push(
      insertUnresolved(db, runId, null, null, null, `Failed to list Orthanc studies: ${String(err)}`, null)
    )
  }

  db.prepare(`
    UPDATE dicom_import_runs
    SET studies_scanned = ?, matched = ?, unresolved = ?, errors = ?
    WHERE id = ?
  `).run(studiesScanned, matchedStudies, unresolvedItems.length, errors, runId)

  return {
    run_id: runId,
    studies_scanned: studiesScanned,
    matched: matchedStudies,
    unresolved: unresolvedItems.length,
    errors,
    links: importedLinks,
    reference_links: importedReferenceLinks,
    conclusion_links: importedConclusionLinks,
    unresolved_items: unresolvedItems
  }
}
