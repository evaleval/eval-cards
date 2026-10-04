/**
 * Downloads the HF dataset snapshot to local cache during build.
 * This avoids hitting HF rate limits at runtime and during cache refresh.
 *
 * Phase 1: Clone the dataset snapshot once via Git
 * Phase 2: Copy index files (model-cards, eval-list, developers, benchmark-metadata, peer-ranks)
 * Phase 3: Copy detail directories (developers/*.json, evals/*.json, models/*.json)
 *
 * Run with:  node scripts/cache-hf-data.mjs
 */

import { execFile } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promisify } from "util"

const root = path.resolve(new URL(import.meta.url).pathname, "..", "..")
const cacheDir = path.join(root, ".cache", "hf-data")
const publicDir = path.join(root, "public")
const dataBackend = process.env.DATA_BACKEND?.trim().toLowerCase()
if (dataBackend === "v2" || dataBackend === "stage-j") {
  await fs.mkdir(cacheDir, { recursive: true })
  console.log("[cache-hf-data] DATA_BACKEND=v2: skipping legacy HF cache; runtime reads SNAPSHOT_URL")
  process.exit(0)
}

const HF_DATASET_REPO = process.env.HF_DATASET_REPO?.trim()
  || "https://huggingface.co/datasets/evaleval/card_backend"
const HF_RESOLVE_BASE = `${HF_DATASET_REPO}/resolve/main`
const execFileAsync = promisify(execFile)

// Lean DuckDB mode: when DATA_BACKEND=duckdb, the runtime reads model/eval/
// developer/summary data exclusively from `duckdb/v1/*.parquet` (see
// lib/duckdb-data.ts:48,82). The legacy JSON-fallback artifacts
// (model-cards*, eval-list*, developers*, plus the per-slug detail
// directories developers/, evals/, models/) become dead weight — skipping
// them avoids OOMing the HF Space on a 2.8 GB JSON snapshot.
//
// Always keep:
//   - manifest.json           (lib/data-backend.ts:96 → /api/backend-manifest)
//   - eval-hierarchy.json     (lib/data-backend.ts:98 → /api/eval-hierarchy)
//   - benchmark-metadata.json (lib/benchmark-metadata.ts:5 → /api/benchmark-metadata)
//   - comparison-index.json   (lib/hf-data.ts:fetchComparisonSlice slices it per page for /api/comparison-index)
//   - corpus-aggregates.json  (app/corpus/page.tsx via lib/hf-data:fetchCorpusAggregates)
//   - duckdb/v1/*.parquet     (lib/duckdb-data.ts read path)
//   - public/peer-ranks.json  (always written outside cacheDir; component fetches HF directly)
const isDuckDBLean = process.env.DATA_BACKEND?.trim().toLowerCase() === "duckdb"

const ESSENTIAL_CACHE_ROOT_FILES = [
  "manifest.json",
  "benchmark-metadata.json",
  "eval-hierarchy.json",
  "comparison-index.json",
  "corpus-aggregates.json",
]

const JSON_FALLBACK_CACHE_ROOT_FILES = [
  "model-cards.json",
  "model-cards-lite.json",
  "eval-list.json",
  "eval-list-lite.json",
  "developers.json",
]

const CACHE_ROOT_FILES = isDuckDBLean
  ? ESSENTIAL_CACHE_ROOT_FILES
  : [...ESSENTIAL_CACHE_ROOT_FILES, ...JSON_FALLBACK_CACHE_ROOT_FILES]

const OPTIONAL_CACHE_ROOT_FILES = new Set([
  "model-cards-lite.json",
  "eval-list-lite.json",
  "corpus-aggregates.json",
])

const ESSENTIAL_CACHE_DIRECTORIES = ["duckdb"]
const JSON_FALLBACK_CACHE_DIRECTORIES = ["developers", "evals", "models"]

const CACHE_DIRECTORIES = isDuckDBLean
  ? ESSENTIAL_CACHE_DIRECTORIES
  : [...JSON_FALLBACK_CACHE_DIRECTORIES, ...ESSENTIAL_CACHE_DIRECTORIES]

const TOKEN_CASE_MAP = {
  ai: "AI",
  claude: "Claude",
  fc: "FC",
  gemini: "Gemini",
  gemma: "Gemma",
  gpt: "GPT",
  haiku: "Haiku",
  mini: "Mini",
  opus: "Opus",
  preview: "Preview",
  pro: "Pro",
  prompt: "Prompt",
  reasoning: "Reasoning",
  sonnet: "Sonnet",
  thinking: "Thinking",
}

async function runGit(args, cwd) {
  await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 32,
  })
}

async function cloneDatasetSnapshot(targetDir) {
  await runGit(["clone", "--depth", "1", "--single-branch", HF_DATASET_REPO, targetDir], root)
}

async function ensureCleanDirectory(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
  await fs.mkdir(dirPath, { recursive: true })
}

async function copyFile(sourcePath, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true })
  await fs.copyFile(sourcePath, destinationPath)
  const stat = await fs.stat(destinationPath)
  return stat.size
}

function isGitLfsPointer(contents) {
  return contents.startsWith("version https://git-lfs.github.com/spec/v1\n")
}

async function writeRemoteFile(relativePath, destinationPath) {
  const headers = {}
  const hfToken = process.env.HF_TOKEN?.trim()
  if (hfToken) {
    headers.Authorization = `Bearer ${hfToken}`
  }
  const response = await fetch(`${HF_RESOLVE_BASE}/${relativePath}`, { headers })
  if (!response.ok) {
    throw new Error(`Failed to download ${relativePath}: ${response.status} ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await fs.mkdir(path.dirname(destinationPath), { recursive: true })
  await fs.writeFile(destinationPath, buffer)
  return buffer.length
}

async function copySnapshotFile(snapshotRoot, relativePath, destinationPath) {
  const sourcePath = path.join(snapshotRoot, relativePath)
  const contents = await fs.readFile(sourcePath, "utf8")

  if (isGitLfsPointer(contents)) {
    const size = await writeRemoteFile(relativePath, destinationPath)
    return { size, source: "remote" }
  }

  const size = await copyFile(sourcePath, destinationPath)
  return { size, source: "snapshot" }
}

async function copySnapshotDirectory(snapshotRoot, relativeDir, destinationDir) {
  const sourceDir = path.join(snapshotRoot, relativeDir)
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })

  let fileCount = 0
  let remoteCount = 0

  for (const entry of entries) {
    const nestedRelativePath = path.posix.join(relativeDir, entry.name)
    const destinationPath = path.join(destinationDir, entry.name)

    if (entry.isDirectory()) {
      await ensureCleanDirectory(destinationPath)
      const nested = await copySnapshotDirectory(snapshotRoot, nestedRelativePath, destinationPath)
      fileCount += nested.fileCount
      remoteCount += nested.remoteCount
      continue
    }

    const result = await copySnapshotFile(snapshotRoot, nestedRelativePath, destinationPath)
    fileCount += 1
    remoteCount += result.source === "remote" ? 1 : 0
  }

  return { fileCount, remoteCount }
}

function normalizeHandle(rawHandle) {
  return rawHandle
    .trim()
    .toLowerCase()
    .replace(/[_\s/]+/g, "-")
    .replace(/(\d)-(?=\d(?:-|$))/g, "$1.")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function formatVersionDate(dateToken) {
  if (!/^(?:19|20)\d{6}$/.test(dateToken)) {
    return dateToken
  }

  return `${dateToken.slice(0, 4)}-${dateToken.slice(4, 6)}-${dateToken.slice(6, 8)}`
}

function titleCaseToken(token) {
  if (!token) {
    return token
  }

  if (TOKEN_CASE_MAP[token]) {
    return TOKEN_CASE_MAP[token]
  }

  if (/^\d+(\.\d+)?$/.test(token)) {
    return token
  }

  if (/^\d+(\.\d+)?[bkmt]$/i.test(token)) {
    return `${token.slice(0, -1)}${token.slice(-1).toUpperCase()}`
  }

  return token.charAt(0).toUpperCase() + token.slice(1)
}

function humanizeHandle(handle) {
  return handle
    .split("-")
    .filter(Boolean)
    .map((token) => (/^(?:19|20)\d{6}$/.test(token) ? formatVersionDate(token) : titleCaseToken(token)))
    .join(" ")
}

function getCanonicalFamilyInfo(modelFamilyId) {
  const [namespace = "unknown", rawHandle = ""] = String(modelFamilyId).split("/")
  const normalizedHandle = normalizeHandle(rawHandle)
  const match = normalizedHandle.match(/^(.*?)-((?:19|20)\d{6})(?:-(.+))?$/)
  const familySlug = match ? match[1] : normalizedHandle

  return {
    familyId: `${namespace}/${familySlug}`,
    familyName: humanizeHandle(familySlug),
  }
}

function normalizeSetupAliasQualifier(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-")
}

function isSetupAliasQualifier(value) {
  const normalized = normalizeSetupAliasQualifier(value)
  return (
    normalized === "prompt" ||
    normalized === "fc" ||
    normalized === "function-calling" ||
    normalized.startsWith("thinking")
  )
}

function getNormalizedVariantMeta(familyId, variantKey, variantLabel) {
  if (variantKey === "default" || variantKey === "base") {
    return {
      variantKey: "default",
      variantLabel: "Default",
    }
  }

  const familyHandle = familyId.split("/")[1] ?? ""
  const compositeHandle = normalizeHandle(`${familyHandle}-${variantKey}`)
  const match = compositeHandle.match(/^(.*?)-((?:19|20)\d{6})(?:-(.+))?$/)

  if (!match) {
    return {
      variantKey,
      variantLabel,
    }
  }

  const [, , dateToken, qualifier] = match
  if (qualifier && isSetupAliasQualifier(humanizeHandle(qualifier))) {
    const formattedDate = formatVersionDate(dateToken)
    return {
      variantKey: formattedDate,
      variantLabel: formattedDate,
    }
  }

  const formattedDate = formatVersionDate(dateToken)
  return {
    variantKey,
    variantLabel: qualifier ? `${formattedDate} · ${humanizeHandle(qualifier)}` : formattedDate,
  }
}

function normalizeModelCardEntry(entry) {
  const familyInfo = getCanonicalFamilyInfo(entry.model_family_id)
  const variantsByKey = new Map()

  for (const variant of entry.variants ?? []) {
    const meta = getNormalizedVariantMeta(familyInfo.familyId, variant.variant_key, variant.variant_label)
    const existing = variantsByKey.get(meta.variantKey)

    if (existing) {
      existing.evaluation_count += variant.evaluation_count
      existing.last_updated =
        !existing.last_updated || (variant.last_updated && new Date(variant.last_updated).getTime() > new Date(existing.last_updated).getTime())
          ? variant.last_updated
          : existing.last_updated
      existing.raw_model_ids = Array.from(
        new Set([...(existing.raw_model_ids ?? []), ...(variant.raw_model_ids ?? [])])
      ).sort((a, b) => a.localeCompare(b))
      continue
    }

    variantsByKey.set(meta.variantKey, {
      ...variant,
      variant_key: meta.variantKey,
      variant_label: meta.variantLabel,
      raw_model_ids: [...(variant.raw_model_ids ?? [])].sort((a, b) => a.localeCompare(b)),
    })
  }

  const variants = Array.from(variantsByKey.values()).sort((a, b) => {
    const aIsDefault = a.variant_key === "default"
    const bIsDefault = b.variant_key === "default"
    if (aIsDefault !== bIsDefault) {
      return aIsDefault ? -1 : 1
    }

    const aTime = a.last_updated ? new Date(a.last_updated).getTime() : Number.NEGATIVE_INFINITY
    const bTime = b.last_updated ? new Date(b.last_updated).getTime() : Number.NEGATIVE_INFINITY
    if (aTime !== bTime) {
      return bTime - aTime
    }

    return a.variant_label.localeCompare(b.variant_label)
  })

  return {
    ...entry,
    model_family_id: familyInfo.familyId,
    model_route_id: familyInfo.familyId.replace(/\//g, "__"),
    model_family_name: familyInfo.familyName,
    total_evaluations:
      variants.length > 0
        ? variants.reduce((sum, variant) => sum + (variant.evaluation_count ?? 0), 0)
        : entry.total_evaluations,
    variants,
  }
}

async function normalizeCachedModelCardFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8")
    const data = JSON.parse(text)
    if (!Array.isArray(data)) {
      return
    }

    const normalized = data.map(normalizeModelCardEntry)
    await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`)
  } catch (error) {
    console.warn(`  ○ failed to normalize ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function countFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  let count = 0

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      count += await countFiles(fullPath)
      continue
    }

    count += 1
  }

  return count
}

async function main() {
  console.log("Caching HF dataset snapshot for build...\n")

  if (isDuckDBLean) {
    console.log("Lean DuckDB cache mode: skipping JSON-fallback artifacts (model-cards*, eval-list*, developers*, developers/, evals/, models/)")
    console.log("")
  }

  await fs.mkdir(cacheDir, { recursive: true })
  await fs.mkdir(publicDir, { recursive: true })

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "card-backend-"))

  try {
    // ── Phase 1: Clone snapshot ───────────────────────────────────────────
    console.log("Phase 1: Clone dataset snapshot")
    await cloneDatasetSnapshot(tempDir)
    console.log(`  ✓ cloned ${HF_DATASET_REPO}`)

    // ── Phase 2: Root files ───────────────────────────────────────────────
    console.log("\nPhase 2: Copy index files")
    for (const fileName of CACHE_ROOT_FILES) {
      const destinationPath = path.join(cacheDir, fileName)
      try {
        const result = await copySnapshotFile(tempDir, fileName, destinationPath)
        const suffix = result.source === "remote" ? ", resolved from LFS" : ""
        console.log(`  ✓ ${fileName} (${(result.size / 1024).toFixed(0)} KB${suffix})`)
      } catch (error) {
        if (
          OPTIONAL_CACHE_ROOT_FILES.has(fileName) &&
          typeof error === "object" &&
          error != null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          console.log(`  ○ ${fileName} not published yet; skipping`)
          continue
        }

        throw error
      }
    }

    const peerRanksResult = await copySnapshotFile(
      tempDir,
      "peer-ranks.json",
      path.join(publicDir, "peer-ranks.json")
    )
    const peerRanksSuffix = peerRanksResult.source === "remote" ? ", resolved from LFS" : ""
    console.log(`  ✓ peer-ranks.json (${(peerRanksResult.size / 1024).toFixed(0)} KB${peerRanksSuffix})`)

    if (!isDuckDBLean) {
      await normalizeCachedModelCardFile(path.join(cacheDir, "model-cards.json"))
      await normalizeCachedModelCardFile(path.join(cacheDir, "model-cards-lite.json"))
      console.log("  ✓ normalized model card artifacts")
    }

    // ── Phase 3: Detail directories ─────────────────────────────────────
    console.log("\nPhase 3: Copy detail directories")
    for (const directoryName of CACHE_DIRECTORIES) {
      const destinationPath = path.join(cacheDir, directoryName)
      await ensureCleanDirectory(destinationPath)
      const result = await copySnapshotDirectory(tempDir, directoryName, destinationPath)
      const remoteSuffix = result.remoteCount > 0 ? `, ${result.remoteCount} resolved from LFS` : ""
      console.log(`  ✓ ${directoryName}/ (${result.fileCount} files${remoteSuffix})`)
    }

    console.log("\nDone.")
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
