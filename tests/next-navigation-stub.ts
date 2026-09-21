/**
 * Next's navigation hooks for the static-render component tests.
 *
 * The app mounts a router; `renderToStaticMarkup` does not, and
 * `useRouter` throws without one. Supplying the context here keeps the
 * components on the same hook path they take in production, instead of
 * having them branch on whether they happen to be inside the app.
 *
 * Used as `vi.mock("next/navigation", () => import("./next-navigation-stub"))`.
 */

const noop = () => {}

export function usePathname(): string {
  return "/evals/test"
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams()
}

export function useParams(): Record<string, string | string[]> {
  return {}
}

export function useRouter() {
  return {
    replace: noop,
    push: noop,
    back: noop,
    forward: noop,
    refresh: noop,
    prefetch: noop,
  }
}
