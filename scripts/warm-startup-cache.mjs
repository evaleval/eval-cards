const DEFAULT_BASE_URL = process.argv[2] || process.env.STARTUP_WARMUP_BASE_URL || "http://127.0.0.1:3000"
const WARMUP_ENABLED = process.env.STARTUP_WARMUP !== "0"
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.STARTUP_WARMUP_TIMEOUT_MS ?? "120000", 10)
const RETRY_DELAY_MS = 1000
const MAX_READY_ATTEMPTS = 60

const ENDPOINTS = [
  "/api/model-cards-lite",
  "/api/eval-list-lite",
  "/api/benchmark-metadata",
  "/api/corpus-aggregates",
  "/api/eval-hierarchy",
]

function withBaseUrl(path) {
  return `${DEFAULT_BASE_URL.replace(/\/+$/, "")}${path}`
}

async function fetchWithTimeout(url) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    await response.arrayBuffer()
  } finally {
    clearTimeout(timeoutId)
  }
}

async function waitForServer() {
  const url = withBaseUrl(ENDPOINTS[0])
  for (let attempt = 1; attempt <= MAX_READY_ATTEMPTS; attempt++) {
    try {
      await fetchWithTimeout(url)
      return
    } catch (error) {
      if (attempt === MAX_READY_ATTEMPTS) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

async function warmEndpoints() {
  for (const path of ENDPOINTS.slice(1)) {
    try {
      await fetchWithTimeout(withBaseUrl(path))
      console.log(`[warm-startup-cache] warmed ${path}`)
    } catch (error) {
      console.warn(
        `[warm-startup-cache] failed to warm ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

async function main() {
  if (!WARMUP_ENABLED) {
    console.log("[warm-startup-cache] disabled via STARTUP_WARMUP=0")
    return
  }

  try {
    await waitForServer()
    console.log("[warm-startup-cache] server is ready; warming route caches")
    await warmEndpoints()
  } catch (error) {
    console.warn(
      `[warm-startup-cache] skipped after readiness failure: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

await main()