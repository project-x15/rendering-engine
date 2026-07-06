import type { Route, MatchedRoute } from './types.js'

/**
 * Match a pathname against the route table.
 * Supports exact ("/"), static ("/browse"), and params ("/watch/:id").
 * No wildcards, no regex. Returns first match.
 */
export function matchRoute(routes: Route[], pathname: string): MatchedRoute | null {
  let path = pathname
  if (path.length > 1 && path.charAt(path.length - 1) === '/') {
    path = path.slice(0, -1)
  }

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]
    const params = matchPath(route.path, path)
    if (params === null) continue
    // Run validateParams if present — treat as no-match if validation fails
    if (route.validateParams && !route.validateParams(params)) continue
    return { route, params }
  }
  return null
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)

  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]
    const actual = pathParts[i]
    if (pp.charAt(0) === ':') {
      try {
        params[pp.slice(1)] = decodeURIComponent(actual)
      } catch {
        // Malformed percent-encoding (e.g. %zz) — treat as no-match
        return null
      }
    } else if (pp !== actual) {
      return null
    }
  }
  return params
}