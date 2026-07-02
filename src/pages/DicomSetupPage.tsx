import React from 'react'
import { useAppStore } from '../store/appStore'
import { DicomSyncPanel } from './AdminPage'

export default function DicomSetupPage(): React.JSX.Element {
  const { openSetupFresh, setScreen } = useAppStore()

  async function goToLogin(): Promise<void> {
    await window.api.configSet('initial_setup_complete', '1')
    setScreen('login')
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">DICOM Sync</h1>
        <div className="flex gap-3">
          <button
            onClick={openSetupFresh}
            className="px-4 py-2 bg-slate-200 text-slate-700 text-sm font-semibold rounded-lg hover:bg-slate-300"
          >
            Back to Setup
          </button>
          <button
            onClick={goToLogin}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700"
          >
            Go to Login
          </button>
        </div>
      </header>

      <main className="p-6 max-w-5xl mx-auto">
        <div className="bg-white rounded-2xl shadow p-6">
          <DicomSyncPanel />
        </div>
      </main>
    </div>
  )
}
