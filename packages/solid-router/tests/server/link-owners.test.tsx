import * as Solid from 'solid-js'
import { describe, expect, test } from 'vitest'
import { renderToString } from '@solidjs/web'
import {
  Link,
  RouterProvider,
  createLink,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '../../src'
import {
  EXPECTED_LINK_OWNERS,
  createOwnerTestRouter,
  measureLinkOwners,
} from '../linkOwnerCases'
import type { JSX } from '@solidjs/web'

describe('Link owners and markup (server)', () => {
  // tests/link-owners.test.tsx asserts the same table on the client.
  test('a Link consumes the same owner ids as on the client', async () => {
    const router = await createOwnerTestRouter()
    expect(measureLinkOwners(router)).toEqual(EXPECTED_LINK_OWNERS)
  })

  test('renders href, active state, accessor props and render-prop children', async () => {
    const HostLink = createLink((props: { children?: JSX.Element }) => (
      <a {...props} />
    ))
    const [signedIn] = Solid.createSignal(true)
    const rootRoute = createRootRoute()
    const postsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/posts',
      component: () => (
        <nav>
          <Link to="/posts">
            {(state: { isActive: boolean }) =>
              state.isActive ? 'Posts (current)' : 'Posts'
            }
          </Link>
          <Link
            to="/about"
            class="nav"
            activeProps={{ class: 'on' }}
            title={signedIn() ? 'About us' : 'Sign in'}
            preload="intent"
            onMouseEnter={() => {}}
          >
            About
          </Link>
          <Link to="/about" disabled>
            Disabled
          </Link>
          <HostLink to="/posts">Host</HostLink>
        </nav>
      ),
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        postsRoute,
        createRoute({ getParentRoute: () => rootRoute, path: '/about' }),
      ]),
      history: createMemoryHistory({ initialEntries: ['/posts'] }),
    })
    await router.load()

    const html = await renderToString(() => <RouterProvider router={router} />)
    const anchors = [...html.matchAll(/<a\b[^>]*>.*?<\/a>/g)].map(([a]) =>
      a.replace(/ _hk=[^\s>]*/g, ''),
    )

    expect(anchors).toEqual([
      '<a href="/posts" data-status="active" aria-current="page" class="active">Posts (current)</a>',
      '<a title="About us" href="/about" class="nav">About</a>',
      '<a disabled role="link" aria-disabled="true">Disabled</a>',
      '<a href="/posts" data-status="active" aria-current="page" class="active">Host</a>',
    ])
  })
})
