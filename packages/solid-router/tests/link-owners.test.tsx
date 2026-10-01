import * as Solid from 'solid-js'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import {
  Link,
  RouterContextProvider,
  createLink,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useLinkProps,
} from '../src'
import {
  EXPECTED_LINK_OWNERS,
  createOwnerTestRouter,
  measureLinkOwners,
} from './linkOwnerCases'
import type { JSX } from '@solidjs/web'

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

async function createTestRouter(defaultPreload: false | 'intent' = 'intent') {
  const rootRoute = createRootRoute()
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/posts' }),
      createRoute({ getParentRoute: () => rootRoute, path: '/about' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/posts'] }),
    defaultPreload,
    defaultPreloadDelay: 0,
  })
  await router.load()
  return router
}

describe('Link owners and props (client)', () => {
  // tests/server/link-owners.test.tsx asserts the same table on the server.
  test('a Link consumes the same owner ids as on the server', async () => {
    const router = await createOwnerTestRouter()
    expect(measureLinkOwners(router)).toEqual(EXPECTED_LINK_OWNERS)
  })

  test('href, active state, class and disabled follow a navigation', async () => {
    const router = await createTestRouter()
    const { getByRole } = render(() => (
      <RouterContextProvider router={router}>
        {() => (
          <>
            <Link to="/posts">Posts link</Link>
            <Link to="/about" class="nav" activeProps={{ class: 'on' }}>
              About link
            </Link>
            <Link to="/about" disabled>
              Disabled link
            </Link>
          </>
        )}
      </RouterContextProvider>
    ))
    const attrs = (name: string) => {
      const el = getByRole('link', { name })
      return {
        href: el.getAttribute('href'),
        current: el.getAttribute('aria-current'),
        status: el.getAttribute('data-status'),
        class: el.getAttribute('class'),
        disabled: el.getAttribute('aria-disabled'),
      }
    }
    const snapshot = () => [
      attrs('Posts link'),
      attrs('About link'),
      attrs('Disabled link'),
    ]

    expect(snapshot()).toEqual([
      {
        href: '/posts',
        current: 'page',
        status: 'active',
        class: 'active',
        disabled: null,
      },
      {
        href: '/about',
        current: null,
        status: null,
        class: 'nav',
        disabled: null,
      },
      {
        href: null,
        current: null,
        status: null,
        class: null,
        disabled: 'true',
      },
    ])

    await router.navigate({ to: '/about' })
    Solid.flush()

    expect(snapshot()).toEqual([
      {
        href: '/posts',
        current: null,
        status: null,
        class: null,
        disabled: null,
      },
      {
        href: '/about',
        current: 'page',
        status: 'active',
        class: 'nav on',
        disabled: null,
      },
      {
        href: null,
        current: 'page',
        status: 'active',
        class: 'active',
        disabled: 'true',
      },
    ])
  })

  test('intent preloading on hover skips a disabled link', async () => {
    const router = await createTestRouter()
    const preload = vi
      .spyOn(router, 'preloadRoute')
      .mockResolvedValue(undefined as never)
    const { getByRole } = render(() => (
      <RouterContextProvider router={router}>
        {() => (
          <>
            <Link to="/about">About link</Link>
            <Link to="/posts" disabled>
              Disabled link
            </Link>
          </>
        )}
      </RouterContextProvider>
    ))

    getByRole('link', { name: 'About link' }).dispatchEvent(
      new MouseEvent('mouseenter'),
    )
    getByRole('link', { name: 'Disabled link' }).dispatchEvent(
      new MouseEvent('mouseenter'),
    )

    expect(preload.mock.calls.map(([options]) => options.to)).toEqual([
      '/about',
    ])
  })

  test('a render-prop child gets the active state, and follows it', async () => {
    const router = await createTestRouter()
    const { getByRole } = render(() => (
      <RouterContextProvider router={router}>
        {() => (
          <Link to="/posts">
            {(state: { isActive: boolean }) =>
              state.isActive ? 'Posts (current)' : 'Posts'
            }
          </Link>
        )}
      </RouterContextProvider>
    ))
    const before = getByRole('link').textContent

    await router.navigate({ to: '/about' })
    Solid.flush()

    expect([before, getByRole('link').textContent]).toEqual([
      'Posts (current)',
      'Posts',
    ])
  })

  test('a createLink host that reads its children twice builds them once', async () => {
    const router = await createTestRouter()
    let built = 0
    const Child = () => {
      built++
      return <span>Posts</span>
    }
    const Host = (props: { href?: string; children?: JSX.Element }) => {
      void props.children
      return <a href={props.href}>{props.children}</a>
    }
    const HostLink = createLink(Host)
    const { getByRole } = render(() => (
      <RouterContextProvider router={router}>
        {() => (
          <HostLink to="/posts">
            <Child />
          </HostLink>
        )}
      </RouterContextProvider>
    ))

    expect([built, getByRole('link').getAttribute('href')]).toEqual([
      1,
      '/posts',
    ])
  })

  test('intent handlers exist only where intent preloading is possible', async () => {
    const router = await createTestRouter(false)
    const onMouseEnter = () => {}
    let handlerKeys: Array<Array<string>> = []
    render(() => (
      <RouterContextProvider router={router}>
        {() => {
          handlerKeys = [
            useLinkProps({ to: '/posts' }),
            useLinkProps({ to: '/posts', onMouseEnter }),
            useLinkProps({ to: '/posts', preload: 'intent' } as never),
          ].map((props) =>
            Object.keys(props).filter((key) => key.startsWith('on')),
          )
          return null
        }}
      </RouterContextProvider>
    ))

    expect(handlerKeys).toEqual([
      ['onClick'],
      ['onClick', 'onMouseEnter'],
      [
        'onClick',
        'onBlur',
        'onFocus',
        'onMouseEnter',
        'onMouseOver',
        'onMouseLeave',
        'onMouseOut',
        'onTouchStart',
      ],
    ])
  })

  test('the caller handler is handed through while intent preloading is off', async () => {
    const router = await createTestRouter(false)
    const preload = vi
      .spyOn(router, 'preloadRoute')
      .mockResolvedValue(undefined as never)
    const onMouseEnter = vi.fn()
    let props: Record<string, any> = {}
    render(() => (
      <RouterContextProvider router={router}>
        {() => {
          props = useLinkProps({ to: '/posts', preload: false, onMouseEnter })
          return null
        }}
      </RouterContextProvider>
    ))

    expect(props.onMouseEnter).toBe(onMouseEnter)
    expect(preload).not.toHaveBeenCalled()
  })

  // The Solid compiler shares one descriptor per dynamic prop, whose getter
  // reads its closure off `this`; a copied descriptor would read it off the
  // link's own props object.
  test('a forwarded accessor prop is read on the props it came from', async () => {
    const router = await createTestRouter()
    const closure = Symbol('closure')
    const source = {
      to: '/posts',
      [closure]: () => 'Go to posts',
    } as Record<PropertyKey, unknown>
    Object.defineProperty(source, 'aria-label', {
      get(this: Record<PropertyKey, () => string>) {
        return this[closure]?.()
      },
      enumerable: true,
      configurable: true,
    })
    let linkProps: Record<string, unknown> = {}
    render(() => (
      <RouterContextProvider router={router}>
        {() => {
          linkProps = useLinkProps(source as never) as Record<string, unknown>
          return null
        }}
      </RouterContextProvider>
    ))

    expect(linkProps['aria-label']).toBe('Go to posts')
  })

  // A handler can run inside a component body: removing a focused anchor while
  // rendering fires `blur` synchronously, for one.
  test('handlers read the link state untracked', async () => {
    const router = await createTestRouter()
    vi.spyOn(router, 'preloadRoute').mockResolvedValue(undefined as never)
    const warn = vi.spyOn(console, 'warn')
    const [fire, setFire] = Solid.createSignal(false)
    let anchor: HTMLAnchorElement | undefined
    const FireInBody = () => {
      for (const type of [
        'mouseenter',
        'mouseleave',
        'focus',
        'blur',
        'touchstart',
      ]) {
        anchor!.dispatchEvent(new Event(type))
      }
      return null
    }
    render(() => (
      <RouterContextProvider router={router}>
        {() => (
          <>
            <Link to="/about" ref={(el: HTMLAnchorElement) => (anchor = el)}>
              About link
            </Link>
            <Solid.Show when={fire()}>
              <FireInBody />
            </Solid.Show>
          </>
        )}
      </RouterContextProvider>
    ))

    setFire(true)
    Solid.flush()

    expect(anchor).toBeDefined()
    expect(
      warn.mock.calls.filter((args) =>
        String(args[0]).includes('STRICT_READ_UNTRACKED'),
      ),
    ).toEqual([])
  })
})
