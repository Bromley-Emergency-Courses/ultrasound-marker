import React, { useState, useEffect } from 'react'
import { useAppStore } from '../store/appStore'
import ImageViewer from '../components/ImageViewer'
import DicomPreviewStack from '../components/DicomPreviewStack'
import CandidateInstructionsPanel from '../components/CandidateInstructionsPanel'
import type { DicomStudyLink, ExaminerFormMarkDetail, FieldResponseInput, DisagreementRow, ReferenceImages, StationFormField } from '../types/ipc'

type MarkValue = number | null

export default function ResolutionPage(): React.JSX.Element {
  const { examinerName, resolutionContext, setScreen } = useAppStore()
  const ctx = resolutionContext!

  const [disagreements, setDisagreements] = useState<DisagreementRow[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [marks, setMarks] = useState<ExaminerFormMarkDetail[]>([])
  const [loading, setLoading] = useState(true)

  // Consensus inputs
  const [consensusScores, setConsensusScores] = useState<Record<string, number | null>>({})
  const [validationError, setValidationError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Images for re-examination
  const [imagesOpen, setImagesOpen] = useState(false)
  const [img1Data, setImg1Data] = useState<string | null>(null)
  const [img2Data, setImg2Data] = useState<string | null>(null)
  const [refImg1Data, setRefImg1Data] = useState<string | null>(null)
  const [refImg2Data, setRefImg2Data] = useState<string | null>(null)
  const [refImages, setRefImages] = useState<ReferenceImages>({
    img1Path: null,
    img2Path: null,
    img1DicomLink: null,
    img2DicomLink: null
  })
  const [dicomLinks, setDicomLinks] = useState<DicomStudyLink[]>([])
  const [imagesLoading, setImagesLoading] = useState(false)
  const [showingStudentImg, setShowingStudentImg] = useState<1 | 2>(1)
  const [showingRefImg, setShowingRefImg] = useState<1 | 2>(1)

  const scoreFields = (ctx.form_fields ?? []).filter((field) => field.field_type === 'score')

  useEffect(() => {
    loadDisagreements()
  }, [])

  async function loadDisagreements(): Promise<void> {
    setLoading(true)
    const list = await window.api.getDisagreements(ctx.module_code, ctx.station_number)
    setDisagreements(list)
    if (list.length > 0) {
      setSelectedIdx(0)
      await loadStudentData(list[0])
    }
    setLoading(false)
  }

  async function loadStudentData(student: DisagreementRow): Promise<void> {
    setConsensusScores({})
    setValidationError(null)
    setMarks([])
    setImg1Data(null)
    setImg2Data(null)
    setRefImg1Data(null)
    setRefImg2Data(null)
    setRefImages({ img1Path: null, img2Path: null, img1DicomLink: null, img2DicomLink: null })
    setDicomLinks([])
    setShowingStudentImg(1)
    setShowingRefImg(1)

    setImagesLoading(true)
    try {
      const [examinerMarks, studentImgs, refImgs, links] = await Promise.all([
        window.api.getExaminerMarks(student.student_id, ctx.module_code, ctx.station_number),
        window.api.getStudentImages(student.student_id, ctx.module_code, ctx.station_number),
        window.api.getReferenceImages(ctx.module_code, ctx.station_number),
        window.api.getDicomLinksForStation(student.student_id, ctx.module_code, ctx.station_number)
      ])
      setMarks(examinerMarks)
      setRefImages(refImgs)
      setDicomLinks(links)

      // Load local image data only when there is no linked DICOM study for that side.
      // DICOM previews are fetched by DicomPreviewStack only when the image panel is open.
      const hasDicomStudy = links.length > 0
      const reads = await Promise.allSettled([
        !hasDicomStudy && studentImgs.img1Path ? window.api.readImageFile(studentImgs.img1Path) : Promise.resolve(null),
        !hasDicomStudy && studentImgs.img2Path ? window.api.readImageFile(studentImgs.img2Path) : Promise.resolve(null),
        !refImgs.img1DicomLink && refImgs.img1Path ? window.api.readImageFile(refImgs.img1Path) : Promise.resolve(null),
        !refImgs.img2DicomLink && refImgs.img2Path ? window.api.readImageFile(refImgs.img2Path) : Promise.resolve(null)
      ])
      const val = (r: PromiseSettledResult<string | null>): string | null =>
        r.status === 'fulfilled' ? r.value : null
      setImg1Data(val(reads[0]))
      setImg2Data(val(reads[1]))
      setRefImg1Data(val(reads[2]))
      setRefImg2Data(val(reads[3]))
    } catch (err) {
      console.error('Resolution image loading failed:', err)
    } finally {
      setImagesLoading(false)
    }
  }

  async function selectStudent(idx: number): Promise<void> {
    setSelectedIdx(idx)
    await loadStudentData(disagreements[idx])
  }

  function validate(): boolean {
    for (const field of scoreFields) {
      if (field.required && (consensusScores[field.field_id] === null || consensusScores[field.field_id] === undefined)) {
        setValidationError(`Please set consensus score for ${field.label}.`)
        return false
      }
    }
    return true
  }

  async function handleSaveConsensus(): Promise<void> {
    if (!validate()) return
    const student = disagreements[selectedIdx]
    setSaving(true)
    const responses: FieldResponseInput[] = scoreFields.map((field) => ({
      field_id: field.field_id,
      field_type: 'score',
      value_num: consensusScores[field.field_id] ?? null
    }))
    await window.api.saveDynamicConsensus(
      student.student_id,
      ctx.module_code,
      ctx.station_number,
      examinerName!,
      responses
    )
    setSaving(false)

    // Move to next disagreement
    const remaining = await window.api.getDisagreements(ctx.module_code, ctx.station_number)
    setDisagreements(remaining)

    if (remaining.length === 0) {
      setScreen('dashboard')
    } else {
      const nextIdx = Math.min(selectedIdx, remaining.length - 1)
      setSelectedIdx(nextIdx)
      await loadStudentData(remaining[nextIdx])
    }
  }

  const e1 = marks[0] ?? null
  const e2 = marks[1] ?? null

  function responseValue(mark: ExaminerFormMarkDetail | null, fieldId: string): number | null {
    const response = mark?.responses.find((r) => r.field_id === fieldId)
    return response?.value_num ?? null
  }

  function differs(field: StationFormField): boolean {
    const v1 = responseValue(e1, field.field_id)
    const v2 = responseValue(e2, field.field_id)
    if (v1 === null || v2 === null) return true
    return Math.abs(v1 - v2) > field.tolerance
  }

  function computedScore(): number | null {
    let total = 0
    for (const field of scoreFields) {
      const value = consensusScores[field.field_id]
      if (field.required && (value === null || value === undefined)) return null
      if (value !== null && value !== undefined) total += value
    }
    return total
  }

  if (loading) {
    return (
      <Shell ctx={ctx} onBack={() => setScreen('dashboard')}>
        <div className="flex-1 flex items-center justify-center text-slate-500">Loading…</div>
      </Shell>
    )
  }

  if (disagreements.length === 0) {
    return (
      <Shell ctx={ctx} onBack={() => setScreen('dashboard')}>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-slate-500">
          <p className="text-lg font-semibold">No disagreements remaining for this station.</p>
          <button
            onClick={() => setScreen('dashboard')}
            className="px-6 py-2 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700"
          >
            Back to Dashboard
          </button>
        </div>
      </Shell>
    )
  }

  const currentStudent = disagreements[selectedIdx]
  const score = computedScore()
  const activeDicomLink = dicomLinks[0] ?? null
  const currentStudentData = showingStudentImg === 1 ? img1Data : img2Data
  const currentRefData = showingRefImg === 1 ? refImg1Data : refImg2Data
  const activeReferenceDicomLink = showingRefImg === 1
    ? refImages.img1DicomLink
    : refImages.img2DicomLink ?? refImages.img1DicomLink

  return (
    <Shell ctx={ctx} onBack={() => setScreen('dashboard')}>
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: student list */}
        <div className="w-64 flex-shrink-0 bg-white rounded-xl border border-slate-200 overflow-y-auto">
          <p className="px-4 py-3 text-xs font-bold text-slate-500 uppercase border-b border-slate-100">
            Disagreements ({disagreements.length})
          </p>
          {disagreements.map((s, i) => (
            <button
              key={s.student_id}
              onClick={() => selectStudent(i)}
              className={`w-full text-left px-4 py-3 text-sm border-b border-slate-50 hover:bg-slate-50 ${
                i === selectedIdx ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-700'
              }`}
            >
              <p className="font-medium">{s.full_name}</p>
              <p className="text-xs text-slate-400">{s.student_id}</p>
            </button>
          ))}
        </div>

        {/* Right: resolution panel */}
        <div className="flex-1 flex flex-col gap-4 min-h-0 overflow-y-auto">
          <CandidateInstructionsPanel moduleCode={ctx.module_code} stationNumber={ctx.station_number} />
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="font-bold text-slate-800 mb-1">
              Resolve: {currentStudent.full_name}{' '}
              <span className="text-slate-400 font-normal text-sm">({currentStudent.student_id})</span>
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              {ctx.module_name} › Station {ctx.station_number}
            </p>

            {/* Marks comparison table */}
            <table className="w-full text-sm mb-6 border-collapse">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-3 py-2 font-semibold text-slate-600 border border-slate-200">Slot</th>
                  <th className="text-center px-3 py-2 font-semibold text-slate-600 border border-slate-200">
                    {e1?.examiner_name ?? 'Examiner 1'}
                  </th>
                  <th className="text-center px-3 py-2 font-semibold text-slate-600 border border-slate-200">
                    {e2?.examiner_name ?? 'Examiner 2'}
                  </th>
                  <th className="text-center px-3 py-2 font-semibold text-slate-600 border border-slate-200">Status</th>
                </tr>
              </thead>
              <tbody>
                {scoreFields.map((field) => (
                  <MarkRow
                    key={field.field_id}
                    label={field.label}
                    v1={responseValue(e1, field.field_id)}
                    v2={responseValue(e2, field.field_id)}
                    differs={differs(field)}
                  />
                ))}
              </tbody>
            </table>

            {/* Consensus inputs */}
            <div className="border-t border-slate-100 pt-4">
              <p className="text-sm font-bold text-slate-700 mb-3">
                Consensus — enter agreed marks (fields do not pre-fill):
              </p>
              <div className="flex gap-4 flex-wrap items-end">
                {scoreFields.map((field) => (
                  <ConsensusDropdown
                    key={field.field_id}
                    field={field}
                    value={consensusScores[field.field_id] ?? null}
                    onChange={(value) => setConsensusScores((prev) => ({ ...prev, [field.field_id]: value }))}
                  />
                ))}
                {score !== null && (
                  <div className="ml-auto text-right">
                    <p className="text-xs text-slate-500 uppercase font-semibold">Computed Score</p>
                    <p className="text-2xl font-bold text-slate-800">
                      {score.toFixed(2)} / {scoreFields.reduce((sum, field) => sum + (field.max_score ?? 0), 0)}
                    </p>
                  </div>
                )}
              </div>

              {validationError && (
                <p className="mt-3 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {validationError}
                </p>
              )}

              <div className="flex gap-3 mt-4">
                <button
                  onClick={handleSaveConsensus}
                  disabled={saving}
                  className="px-5 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-40 text-sm"
                >
                  {saving ? 'Saving…' : 'Save Consensus'}
                </button>
                {selectedIdx < disagreements.length - 1 && (
                  <button
                    onClick={() => selectStudent(selectedIdx + 1)}
                    className="px-4 py-2 border border-slate-300 text-slate-600 rounded-lg hover:bg-slate-50 text-sm"
                  >
                    Next Disagreement →
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Image re-examination panel */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <button
              onClick={() => setImagesOpen(!imagesOpen)}
              className="w-full flex items-center justify-between px-5 py-3 bg-slate-50 hover:bg-slate-100 text-sm font-semibold text-slate-700"
            >
              <span>Re-examine Images</span>
              <span>{imagesOpen ? '▲ Collapse' : '▼ Expand'}</span>
            </button>
            {imagesOpen && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 p-4">
                <div className="flex flex-col gap-2 min-h-[520px]">
                  {activeDicomLink ? (
                    <>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-semibold text-slate-600 mr-1">Candidate DICOM Study</span>
                        <span className="text-xs text-slate-400 font-mono truncate" title={activeDicomLink.patient_id}>
                          {activeDicomLink.patient_id}
                        </span>
                        <div className="flex-1" />
                        <button
                          onClick={() => window.open(activeDicomLink.ohif_url, '_blank')}
                          className="px-3 py-1 rounded-lg text-xs font-semibold border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100"
                        >
                          Open OHIF
                        </button>
                      </div>
                      <DicomPreviewStack
                        orthancStudyId={activeDicomLink.orthanc_study_id}
                        label={`Candidate DICOM ${activeDicomLink.patient_id}`}
                        className="flex-1 rounded-xl"
                      />
                      {dicomLinks.length > 1 && (
                        <p className="text-xs text-amber-600">
                          Multiple DICOM studies are linked to this station. The newest link is shown.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-1">
                        <span className="text-sm font-semibold text-slate-600 mr-2">Candidate Image</span>
                        <button
                          onClick={() => setShowingStudentImg(1)}
                          className={`px-3 py-1 rounded-lg text-sm font-semibold border transition-colors ${
                            showingStudentImg === 1
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          Image 1
                        </button>
                        <button
                          onClick={() => setShowingStudentImg(2)}
                          className={`px-3 py-1 rounded-lg text-sm font-semibold border transition-colors ${
                            showingStudentImg === 2
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          Image 2
                        </button>
                      </div>
                      <ImageViewer
                        dataUrl={currentStudentData}
                        label={`Candidate Image ${showingStudentImg}`}
                        className="flex-1 rounded-xl"
                        loading={imagesLoading}
                      />
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-2 min-h-[520px]">
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-semibold text-slate-600 mr-2">Reference Image</span>
                    <button
                      onClick={() => setShowingRefImg(1)}
                      className={`px-3 py-1 rounded-lg text-sm font-semibold border transition-colors ${
                        showingRefImg === 1
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      REF 1
                    </button>
                    <button
                      onClick={() => setShowingRefImg(2)}
                      className={`px-3 py-1 rounded-lg text-sm font-semibold border transition-colors ${
                        showingRefImg === 2
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      REF 2
                    </button>
                    <div className="flex-1" />
                    {activeReferenceDicomLink && (
                      <button
                        onClick={() => window.open(activeReferenceDicomLink.ohif_url, '_blank')}
                        className="px-3 py-1 rounded-lg text-xs font-semibold border border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                      >
                        Open OHIF
                      </button>
                    )}
                  </div>
                  {activeReferenceDicomLink ? (
                    <DicomPreviewStack
                      orthancStudyId={activeReferenceDicomLink.orthanc_study_id}
                      label={`REF_${ctx.module_code}_S${ctx.station_number}_IMG${showingRefImg}`}
                      initialIndex={showingRefImg - 1}
                      className="flex-1 rounded-xl"
                    />
                  ) : (
                    <ImageViewer
                      dataUrl={currentRefData}
                      label={`Reference Image ${showingRefImg}`}
                      className="flex-1 rounded-xl"
                      loading={imagesLoading}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  )
}

function MarkRow({
  label,
  v1,
  v2,
  differs
}: {
  label: string
  v1: number | null
  v2: number | null
  differs: boolean
}): React.JSX.Element {
  return (
    <tr className={differs ? 'bg-amber-50' : ''}>
      <td className="px-3 py-2 border border-slate-200 font-medium text-slate-700">{label}</td>
      <td className="px-3 py-2 border border-slate-200 text-center text-slate-700">
        {v1 ?? '—'}
      </td>
      <td className="px-3 py-2 border border-slate-200 text-center text-slate-700">
        {v2 ?? '—'}
      </td>
      <td className="px-3 py-2 border border-slate-200 text-center">
        {differs ? (
          <span className="text-amber-600 font-semibold">⚠ DIFFERS</span>
        ) : (
          <span className="text-green-600">✓ AGREE</span>
        )}
      </td>
    </tr>
  )
}

function ConsensusDropdown({
  field,
  value,
  onChange
}: {
  field: StationFormField
  value: MarkValue
  onChange: (v: MarkValue) => void
}): React.JSX.Element {
  const min = field.min_score ?? 0
  const max = field.max_score ?? 0
  const count = Math.max(0, max - min + 1)
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{field.label}</label>
      <select
        value={value === null ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === '' ? null : parseInt(v))
        }}
        className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">— Select —</option>
        {Array.from({ length: count }, (_, n) => min + n).map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </div>
  )
}

function Shell({
  ctx,
  onBack,
  children
}: {
  ctx: { module_name: string; station_number: number }
  onBack: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-3 flex-shrink-0">
        <button onClick={onBack} className="text-slate-500 hover:text-slate-700 text-sm">
          ← Dashboard
        </button>
        <span className="text-slate-300">|</span>
        <span className="font-semibold text-slate-800">
          Resolve Disagreements — {ctx.module_name} › Station {ctx.station_number}
        </span>
      </header>
      <div className="flex-1 flex flex-col p-4 min-h-0">{children}</div>
    </div>
  )
}
