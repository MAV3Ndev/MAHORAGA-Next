import { useState, type ReactNode } from 'react'
import type { ConnectionSettings } from '../lib/connection'
import { getDefaultApiUrl, isNativeShell, normalizeApiUrl } from '../lib/connection'

interface SetupWizardProps {
  initialConnection: ConnectionSettings
  onComplete: (connection: ConnectionSettings) => Promise<void>
  updateControls?: ReactNode
}

function SentinelMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="5.2"
        y="5.2"
        width="13.6"
        height="13.6"
        rx="3"
        transform="rotate(45 12 12)"
        stroke="var(--color-hud-primary)"
        strokeWidth="1.7"
      />
      <circle cx="12" cy="12" r="2.7" fill="var(--color-hud-primary)" />
    </svg>
  )
}

export function SetupWizard({ initialConnection, onComplete, updateControls }: SetupWizardProps) {
  const [apiUrl, setApiUrl] = useState(initialConnection.apiUrl || getDefaultApiUrl())
  const [bearerToken, setBearerToken] = useState(initialConnection.bearerToken || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nativeShell = isNativeShell()

  const handleSubmit = async () => {
    let normalizedUrl = ''
    try {
      normalizedUrl = normalizeApiUrl(apiUrl)
    } catch {
      setError('API URL is invalid')
      return
    }

    const trimmedToken = bearerToken.trim()

    if (!normalizedUrl) {
      setError('API URL is required')
      return
    }

    if (!trimmedToken) {
      setError('Bearer token is required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      await onComplete({
        apiUrl: normalizedUrl,
        bearerToken: trimmedToken,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to MAHORAGA-Next')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-hud-bg flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5">
          <SentinelMark />
          <span className="hud-title-mark">SENTINEL</span>
        </div>
        <p className="mt-2 text-center text-[13px] text-hud-text-dim">
          Connect to your MAHORAGA-Next agent
        </p>

        <div className="mt-8 rounded-xl border border-hud-line bg-hud-bg-panel p-5 shadow-[0_16px_48px_rgb(0_0_0/0.35)]">
          <div className="space-y-4">
            <div>
              <label htmlFor="sentinel-api-url" className="hud-label mb-1.5 block">
                API URL
              </label>
              <input
                id="sentinel-api-url"
                type="text"
                className="hud-input w-full"
                placeholder="https://your-mahoraga-next.workers.dev"
                value={apiUrl}
                onChange={(event) => setApiUrl(event.target.value)}
              />
              <p className="mt-1.5 text-[11px] leading-5 text-hud-text-dim">
                {nativeShell
                  ? 'Enter the public Worker URL. localhost is not reachable from the device.'
                  : 'The deployed Worker URL, or http://localhost:8787 for local dev.'}
              </p>
            </div>

            <div>
              <label htmlFor="sentinel-bearer-token" className="hud-label mb-1.5 block">
                Bearer token
              </label>
              <input
                id="sentinel-bearer-token"
                type="password"
                className="hud-input w-full"
                placeholder="MAHORAGA_API_TOKEN"
                value={bearerToken}
                onChange={(event) => setBearerToken(event.target.value)}
              />
            </div>

            {error && (
              <div className="rounded-lg border border-hud-error/30 bg-hud-error/10 px-3 py-2 text-[12px] text-hud-error">
                {error}
              </div>
            )}

            <button type="button" className="hud-button w-full" onClick={handleSubmit} disabled={saving}>
              {saving ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>

        {updateControls && <div className="mt-4">{updateControls}</div>}
      </div>
    </div>
  )
}
