import * as Solid from 'solid-js'
import {
  Link,
  createLink,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '../src'
import { routerContext } from '../src/routerContext'
import type { JSX } from '@solidjs/web'

/**
 * Shared by tests/link-owners.test.tsx (client) and
 * tests/server/link-owners.test.tsx (server), which assert the same
 * EXPECTED_LINK_OWNERS. Solid 2 mints hydration keys from positions in the
 * owner tree, so a Link must consume the same owner ids on both sides.
 *
 * Each anchor case is measured against a bare anchor of the same JSX shape
 * (`<a {...props}>{children()}</a>`): the unit tests compile non-hydratable,
 * where the server gives an element's child slot an owner the client does
 * not, so only the Link's own owners are comparable across the two builds.
 */

export async function createOwnerTestRouter() {
  const rootRoute = createRootRoute()
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/posts' }),
      createRoute({ getParentRoute: () => rootRoute, path: '/about' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/posts'] }),
    defaultPreload: false,
  })
  await router.load()
  return router
}

const HostLink = createLink((props: { children?: JSX.Element }) => (
  <a {...props} />
))

/** A prop whose every read creates a node, as a compiled ternary prop does. */
function ownerCreatingTitle() {
  return {
    get title() {
      return Solid.createMemo(() => 'Posts')()
    },
  }
}

function BareAnchor(props: { children?: JSX.Element }) {
  const attrs = { href: '/posts' }
  const children = () => props.children
  return <a {...attrs}>{children()}</a>
}

function BareSvgAnchor(props: { children?: JSX.Element }) {
  const attrs = { href: '/posts' }
  const children = () => props.children
  return (
    <svg>
      <a {...attrs}>{children()}</a>
    </svg>
  )
}

interface OwnerCase {
  render: () => JSX.Element
  baseline?: () => JSX.Element
}

const anchor = () => <BareAnchor>Posts</BareAnchor>

// `_asChild` is the prop createLink passes; it is not in Link's public type.
const svgLinkProps: Record<string, unknown> = { to: '/posts', _asChild: 'svg' }

export const OWNER_CASES: Record<string, OwnerCase> = {
  plain: { render: () => <Link to="/posts">Posts</Link>, baseline: anchor },
  'render-prop children': {
    render: () => (
      <Link to="/posts">
        {(state: { isActive: boolean }) => (state.isActive ? 'Here' : 'Posts')}
      </Link>
    ),
    baseline: anchor,
  },
  'active and inactive props': {
    render: () => (
      <Link
        to="/about"
        class="nav"
        activeProps={{ class: 'on', 'data-on': true }}
        inactiveProps={{ 'data-off': true }}
      >
        About
      </Link>
    ),
    baseline: anchor,
  },
  'preload intent': {
    render: () => (
      <Link to="/about" preload="intent">
        About
      </Link>
    ),
    baseline: anchor,
  },
  'preload viewport': {
    render: () => (
      <Link to="/about" preload="viewport">
        About
      </Link>
    ),
    baseline: anchor,
  },
  'preload render': {
    render: () => (
      <Link to="/about" preload="render">
        About
      </Link>
    ),
    baseline: anchor,
  },
  'includeHash active option': {
    render: () => (
      <Link to="/posts" activeOptions={{ includeHash: true }}>
        Posts
      </Link>
    ),
    baseline: anchor,
  },
  'owner-creating accessor prop': {
    render: () => (
      <Link to="/posts" {...ownerCreatingTitle()}>
        Posts
      </Link>
    ),
    baseline: anchor,
  },
  external: {
    render: () => <Link to="https://example.com">External</Link>,
    baseline: anchor,
  },
  svg: {
    render: () => <Link {...(svgLinkProps as { to: '/posts' })}>Posts</Link>,
    baseline: () => <BareSvgAnchor>Posts</BareSvgAnchor>,
  },
  'createLink host': { render: () => <HostLink to="/posts">Posts</HostLink> },
}

/** Renders `render` under a root with a fixed id; returns the ids it consumed. */
export function ownerIdsConsumedBy(
  router: unknown,
  render: () => JSX.Element,
): number {
  const RouterContext = routerContext as unknown as Solid.Component<{
    value: unknown
    children: JSX.Element
  }>
  let consumed = -1
  const Probe = () => {
    Solid.createRoot(
      () => {
        const owner = Solid.getOwner()!
        void render()
        // getNextChildId hands out the next id, so it reads the count.
        consumed = parseInt(Solid.getNextChildId(owner).slice(1), 36)
      },
      { id: 't' },
    )
    return null
  }
  Solid.createRoot((dispose) => {
    const provided = (
      <RouterContext value={router}>
        <Probe />
      </RouterContext>
    ) as unknown as () => unknown
    provided()
    dispose()
  })
  return consumed
}

/**
 * Owner ids each case consumes: over its bare-anchor baseline for an anchor,
 * absolute for a createLink host. The same on the client and the server.
 */
export const EXPECTED_LINK_OWNERS: Record<string, number> = {
  plain: 1,
  'render-prop children': 1,
  'active and inactive props': 1,
  'preload intent': 1,
  // + the IntersectionObserver effect
  'preload viewport': 2,
  // + the render-preload effect
  'preload render': 2,
  // + useHydrated's effect
  'includeHash active option': 2,
  // + the memo the prop builds on each of its two reads (route options, anchor)
  'owner-creating accessor prop': 3,
  external: 1,
  svg: 1,
  'createLink host': 6,
}

export function measureLinkOwners(router: unknown) {
  const out: Record<string, number> = {}
  for (const [name, { render, baseline }] of Object.entries(OWNER_CASES)) {
    out[name] =
      ownerIdsConsumedBy(router, render) -
      (baseline ? ownerIdsConsumedBy(router, baseline) : 0)
  }
  return out
}
