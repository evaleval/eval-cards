"use client"

import { createContext, useContext, useEffect, useMemo, useState } from "react"

import { safeStorage } from "@/lib/safe-storage"

type AudienceMode = "research" | "policy"

interface AudienceModeContextValue {
  mode: AudienceMode
  setMode: (mode: AudienceMode) => void
}

const AudienceModeContext = createContext<AudienceModeContextValue | null>(null)

const STORAGE_KEY = "eval-cards-audience-mode"

export function AudienceModeProvider({
  children,
  initialMode = "research",
}: {
  children: React.ReactNode
  initialMode?: AudienceMode
}) {
  const [mode, setModeState] = useState<AudienceMode>(initialMode)

  useEffect(() => {
    // A `?mode=` query param (used by external embeds / deep-links) takes
    // precedence over the stored preference, so a link can open a card in a
    // specific reader mode. Accepts friendly aliases; `summary` == `policy`.
    const requested = new URLSearchParams(window.location.search)
      .get("mode")
      ?.toLowerCase()
    const fromQuery: AudienceMode | null =
      requested === "policy" || requested === "summary"
        ? "policy"
        : requested === "research" || requested === "researcher"
          ? "research"
          : null
    if (fromQuery) {
      setModeState(fromQuery)
      return
    }
    const storedMode = safeStorage().getItem(STORAGE_KEY)
    if (storedMode === "research" || storedMode === "policy") {
      setModeState(storedMode)
    }
  }, [])

  const setMode = (nextMode: AudienceMode) => {
    setModeState(nextMode)
    safeStorage().setItem(STORAGE_KEY, nextMode)
  }

  const value = useMemo(() => ({ mode, setMode }), [mode])

  return (
    <AudienceModeContext.Provider value={value}>
      {children}
    </AudienceModeContext.Provider>
  )
}

export function useAudienceMode() {
  const context = useContext(AudienceModeContext)

  if (!context) {
    throw new Error("useAudienceMode must be used within an AudienceModeProvider")
  }

  return context
}
