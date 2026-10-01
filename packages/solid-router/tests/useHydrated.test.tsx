import * as Solid from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@solidjs/testing-library'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useHydrated,
} from '../src'

afterEach(() => {
  cleanup()
})

describe('useHydrated', () => {
  // Links no longer call useHydrated, so the router records the first render
  // itself: an app with neither a ClientOnly nor a useHydrated still gets it.
  it('starts at true once the router has rendered', async () => {
    const rootRoute = createRootRoute()
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({
          getParentRoute: () => rootRoute,
          path: '/',
          component: () => <p>Index page</p>,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(() => <RouterProvider router={router} />)
    await screen.findByText('Index page')

    let initial: boolean | undefined
    Solid.createRoot((dispose) => {
      initial = useHydrated()()
      dispose()
    })

    expect(initial).toBe(true)
  })
})
