import * as Solid from 'solid-js'

import {
  deepEqual,
  exactPathTest,
  functionalUpdate,
  hasKeys,
  isDangerousProtocol,
  preloadWarning,
  removeTrailingSlash,
} from '@tanstack/router-core'

import { isServer } from '@tanstack/router-core/isServer'
import { Dynamic } from '@solidjs/web'
import { useRouter } from './useRouter'

import { useIntersectionObserver } from './utils'

import { useHydrated } from './ClientOnly'
import type {
  AnyRouter,
  Constrain,
  LinkOptions,
  ParsedLocation,
  RegisteredRouter,
  RoutePaths,
} from '@tanstack/router-core'
import type {
  ValidateLinkOptions,
  ValidateLinkOptionsArray,
} from './typePrimitives'
import type { ComponentProps, JSX, ValidComponent } from '@solidjs/web'

// Solid 2 mints hydration keys from positions in the owner tree, so a Link
// must create the same owners on the server as on the client. It creates one:
// a memo on the client that resolves the link's whole state, and a bare owner
// in the same position on the server, where the state is resolved once
// (#8316 on the 1.x line). Every branch below that decides which owners exist
// reads only values both sides see identically at setup.

function splitProps<T extends Record<string, any>, TKey extends keyof T>(
  props: T,
  keys: ReadonlyArray<TKey>,
): [Pick<T, TKey>, Omit<T, TKey>] {
  return [props as any, Solid.omit(props, ...(keys as any)) as any]
}

const timeoutMap = new WeakMap<object, ReturnType<typeof setTimeout>>()
const cancelPreload = (eventTarget: object) => {
  clearTimeout(timeoutMap.get(eventTarget))
  timeoutMap.delete(eventTarget)
}

/** The props `useLinkProps` consumes itself; everything else reaches the anchor. */
const LINK_OPTION_KEYS = new Set([
  'activeProps',
  'inactiveProps',
  'activeOptions',
  'to',
  'preload',
  'preloadDelay',
  'preloadIntentProximity',
  'hashScrollIntoView',
  'replace',
  'startTransition',
  'resetScroll',
  'viewTransition',
  'target',
  'disabled',
  'style',
  'class',
  'onClick',
  'onBlur',
  'onFocus',
  'onMouseEnter',
  'onMouseLeave',
  'onMouseOver',
  'onMouseOut',
  'onTouchStart',
  'ignoreBlocker',
  'params',
  'search',
  'hash',
  'state',
  'mask',
  'reloadDocument',
  'unsafeRelative',
  'from',
  'ref',
])
/** The props `Link` consumes itself. */
const LINK_COMPONENT_KEYS = new Set(['_asChild', 'children', 'type'])
const INTENT_KEYS = [
  'onBlur',
  'onFocus',
  'onMouseEnter',
  'onMouseOver',
  'onMouseLeave',
  'onMouseOut',
  'onTouchStart',
] as const
type IntentKey = (typeof INTENT_KEYS)[number]

/** Marks a server reader that forwards the caller's prop unchanged. */
const FORWARDED = () => undefined

type LinkPreload = false | 'intent' | 'viewport' | 'render' | undefined

interface LinkState {
  current: ParsedLocation
  opts: Record<string, any>
  next: ParsedLocation
  href: string | undefined
  externalLink: string | undefined
  preload: LinkPreload
  isActive: boolean
  hydrated?: boolean
}

/**
 * Copies `key` from `source` onto `target`: a data property as data, an
 * accessor as a getter re-read on `source`, since the Solid compiler shares
 * one descriptor per dynamic prop whose getter reads its closure off `this`.
 */
function forwardProp(target: object, source: object, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  Object.defineProperty(
    target,
    key,
    descriptor && !descriptor.get && !descriptor.set
      ? descriptor
      : {
          get: () => (source as Record<string, unknown>)[key],
          enumerable: true,
          configurable: true,
        },
  )
}

function isAccessor(source: object, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  return !!descriptor && (!!descriptor.get || !!descriptor.set)
}

function sameOptions(a: Record<string, any>, b: Record<string, any>) {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

function sameLinkState(a: LinkState, b: LinkState) {
  return (
    a === b ||
    (a.href === b.href &&
      a.externalLink === b.externalLink &&
      a.preload === b.preload &&
      a.isActive === b.isActive &&
      a.next.href === b.next.href &&
      a.next.external === b.next.external &&
      a.next.maskedLocation?.href === b.next.maskedLocation?.href)
  )
}

/** A link's route options: every prop but the `Link` component's own. */
function readRouteOptions(options: Record<string, any>) {
  const out: Record<string, any> = {}
  for (const key of Object.keys(options)) {
    if (key !== 'children' && key !== '_asChild') out[key] = options[key]
  }
  return out
}

function resolveLinkState(
  router: AnyRouter,
  opts: Record<string, any>,
  current: ParsedLocation,
  hideHash: boolean,
): LinkState {
  // untrack because router-core will also access stores, which are signals in solid
  const next = Solid.untrack(() =>
    router.buildLocation({ _fromLocation: current, ...opts } as any),
  )

  let href: string | undefined
  let externalHref: string | undefined
  if (!opts.disabled) {
    // Use publicHref - it contains the correct href for display
    // When a rewrite changes the origin, publicHref is the full URL
    // Otherwise it's the origin-stripped path
    const location = next.maskedLocation ?? next
    if (location.external) {
      href = location.publicHref
      externalHref = location.publicHref
    } else {
      href = router.history.createHref(location.publicHref) || '/'
    }
  }

  let externalLink: string | undefined
  if (externalHref !== undefined) {
    // Block dangerous protocols for external links
    if (isDangerousProtocol(externalHref, router.protocolAllowlist)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`Blocked Link with dangerous protocol: ${externalHref}`)
      }
    } else {
      externalLink = externalHref
    }
  } else {
    externalLink = externalTo(opts.to, router)
  }

  const preload: LinkPreload =
    opts.reloadDocument || externalLink || opts.disabled
      ? false
      : (opts.preload ?? router.options.defaultPreload)
  const isActive =
    !externalLink &&
    testActive(opts.activeOptions, current, next, router, hideHash)

  return { current, opts, next, href, externalLink, preload, isActive }
}

function hasSimpleStyling(opts: Record<string, any>) {
  return (
    opts.activeProps === undefined &&
    opts.inactiveProps === undefined &&
    opts.class === undefined &&
    opts.style === undefined
  )
}

function resolveStateProps(
  opts: Record<string, any>,
  isActive: boolean,
): Record<string, any> {
  return (
    (isActive
      ? functionalUpdate(opts.activeProps ?? STATIC_ACTIVE_PROPS, {})
      : functionalUpdate(opts.inactiveProps ?? EMPTY_OBJECT, {})) ??
    EMPTY_OBJECT
  )
}

function stateClass(
  opts: Record<string, any>,
  isActive: boolean,
  stateProps: Record<string, any>,
) {
  if (hasSimpleStyling(opts)) return isActive ? 'active' : undefined
  return [opts.class, stateProps.class].filter(Boolean).join(' ') || undefined
}

function stateStyle(
  opts: Record<string, any>,
  stateProps: Record<string, any>,
) {
  if (hasSimpleStyling(opts)) return opts.style
  const style = { ...opts.style, ...stateProps.style }
  return hasKeys(style) ? style : undefined
}

export function useLinkProps<
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends RoutePaths<TRouter['routeTree']> | string = string,
  TTo extends string = '',
  TMaskFrom extends RoutePaths<TRouter['routeTree']> | string = TFrom,
  TMaskTo extends string = '',
>(
  options: UseLinkPropsOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>,
): ComponentProps<'a'> {
  return linkProps(options as Record<string, any>, false) as any
}

/**
 * The anchor props of a link. For `Link` (`fromLink`) rendering a plain
 * anchor on the server, this is a function returning them: `ssrElement` calls
 * it right after taking the anchor's hydration key, which is where the
 * client's `spread()` reads the same getters. A prop may be an accessor that
 * builds nodes on every read (Solid 2 compiles a ternary prop to a memo), and
 * those nodes take hydration ids, so each prop is read where, and as often
 * as, the client reads it.
 */
function linkProps(
  options: Record<string, any>,
  fromLink: boolean,
): Record<string, any> | (() => Record<string, any>) {
  const router = useRouter()
  const server = isServer ?? router.isServer

  // Read once, identically on both sides: these decide which owners exist,
  // never what they compute.
  const [requestedPreload, includeHashAtSetup] = Solid.untrack(
    () =>
      [
        (options.preload ?? router.options.defaultPreload) as LinkPreload,
        !!options.activeOptions?.includeHash,
      ] as const,
  )
  const hasHydrated = includeHashAtSetup ? useHydrated() : undefined

  let state: Solid.Accessor<LinkState>
  if (server) {
    // The owner the client's memo would be; route options are read under it
    // on both sides.
    const owner = Solid.createOwner()
    const resolved = Solid.runWithOwner(owner, () =>
      resolveLinkState(
        router,
        readRouteOptions(options),
        router.stores.location.get(),
        false,
      ),
    )
    state = () => resolved
  } else {
    const shouldHydrateHash = !!router.options.ssr
    let last: LinkState | undefined
    state = Solid.createMemo(
      () => {
        const current = router.stores.location.get()
        const opts = readRouteOptions(options)
        const hydrated = hasHydrated ? hasHydrated() : true
        // Navigations usually leave a link's inputs unchanged.
        if (
          last !== undefined &&
          last.current.href === current.href &&
          last.hydrated === hydrated &&
          sameOptions(last.opts, opts)
        ) {
          return last
        }
        last = resolveLinkState(
          router,
          opts,
          current,
          shouldHydrateHash && !hydrated,
        )
        last.hydrated = hydrated
        return last
      },
      { lazy: true, equals: sameLinkState },
    )
  }
  const preload = () => state().preload

  let actions: LinkActions | undefined
  const act = () => (actions ??= createLinkActions(router, options, state))

  let setRef: ((el: Element | null) => void) | undefined
  // The server allocates what these branches allocate and never runs their
  // callbacks.
  if (requestedPreload === 'viewport') {
    const [ref, setRefSignal] = Solid.createSignal<Element | null>(null)
    setRef = (el) => {
      Solid.runWithOwner(null, () => {
        setRefSignal(el)
      })
    }
    useIntersectionObserver(
      ref,
      (e) => act().enqueuePreload(e),
      () => preload() !== 'viewport',
    )
  }
  if (requestedPreload === 'render') {
    let hasRenderFetched = false
    Solid.createEffect(preload, (preloadValue) => {
      if (hasRenderFetched) {
        return
      }
      if (preloadValue === 'render') {
        Solid.untrack(() => act().doPreload())
        hasRenderFetched = true
      }
    })
  }

  const userRef = (el: Element) => {
    const r = options.ref
    if (typeof r === 'function') r(el)
    else if (Array.isArray(r))
      for (const f of r) if (typeof f === 'function') f(el)
  }

  const externalHref = Solid.untrack(() => state().externalLink)
  if (externalHref) {
    const base = fromLink
      ? Solid.omit(options, '_asChild', 'children')
      : options
    const merged = Solid.merge(
      Solid.omit(base, ...(LINK_OPTION_KEYS as Set<any>)),
      {
        ref: setRef
          ? (el: Element) => {
              setRef(el)
              userRef(el)
            }
          : userRef,
        href: externalHref,
      },
      base,
    )
    return fromLink ? Solid.omit(merged, 'type') : merged
  }

  const readers: Record<string, () => unknown> | undefined =
    server && fromLink && (!options._asChild || options._asChild === 'svg')
      ? {}
      : undefined
  const result: Record<string, any> = {}
  const forward = (key: string) => {
    if (readers) readers[key] = FORWARDED
    else forwardProp(result, options, key)
  }

  for (const key of Object.keys(options)) {
    if (LINK_OPTION_KEYS.has(key) || (fromLink && LINK_COMPONENT_KEYS.has(key)))
      continue
    forward(key)
  }

  // On the server a value that reads only data props or the resolved state
  // needs no getter at all.
  const plain = (...keys: Array<string>) =>
    server && !readers && !keys.some((key) => isAccessor(options, key))
  const define = (key: string, get: () => unknown, eager: boolean) => {
    if (readers) readers[key] = get
    else if (!eager)
      Object.defineProperty(result, key, {
        get,
        enumerable: true,
        configurable: true,
      })
    else if (key in result)
      Object.defineProperty(result, key, {
        value: get(),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    else result[key] = get()
  }

  const resolvedStateProps = () => resolveStateProps(options, state().isActive)
  // Keys returned by activeProps/inactiveProps are discovered once at setup.
  Solid.untrack(() => {
    for (const stateProps of [
      functionalUpdate(options.activeProps ?? STATIC_ACTIVE_PROPS, {}),
      functionalUpdate(options.inactiveProps ?? EMPTY_OBJECT, {}),
    ]) {
      if (stateProps) {
        for (const key of Object.keys(stateProps)) {
          if (key !== 'class' && key !== 'style')
            define(
              key,
              () => resolvedStateProps()[key],
              plain('activeProps', 'inactiveProps'),
            )
        }
      }
    }
  })

  if (setRef) {
    const ref = (el: Element) => {
      setRef(el)
      userRef(el)
    }
    define('ref', () => ref, true)
  } else if ('ref' in options) {
    forward('ref')
  }

  // The server never runs a handler, and a handler creates no owner.
  if (!server) {
    result.onClick = (
      e: MouseEvent & { currentTarget: Element; target: Element },
    ) => {
      const handler = options.onClick
      if (!handler || !callHandler(e, handler)) act().handleClick(e)
    }

    // Intent preloading is all these handlers do, and Solid does not delegate
    // mouseenter/mouseleave/focus/blur: a handler handed out anyway is a real
    // listener per anchor. A link that can never preload on intent (no
    // `preload` prop and another default) passes the caller's own handlers
    // through. Otherwise each is a getter resolving to the caller's handler
    // while intent is off, so spread() installs no listener, and flipping
    // `preload` back to 'intent' re-runs it.
    if (requestedPreload === 'intent' || 'preload' in options) {
      let composed: Partial<Record<IntentKey, (event: any) => void>> | undefined
      for (const key of INTENT_KEYS) {
        define(
          key,
          () => {
            if (preload() !== 'intent') return options[key]
            composed ??= {}
            return (composed[key] ??= createComposedHandler(
              () => options[key],
              (e) => act()[key](e),
            ))
          },
          false,
        )
      }
    } else {
      for (const key of INTENT_KEYS) {
        if (key in options) forward(key)
      }
    }
  }

  const stylePlain = plain('class', 'style', 'activeProps', 'inactiveProps')
  define('href', () => state().href, server)
  define('disabled', () => !!options.disabled, plain('disabled'))
  define('target', () => options.target, plain('target'))
  define(
    'role',
    () => (options.disabled ? 'link' : options.role),
    plain('disabled', 'role'),
  )
  define(
    'aria-disabled',
    () => (options.disabled ? 'true' : undefined),
    plain('disabled'),
  )
  define('data-status', () => (state().isActive ? 'active' : undefined), server)
  define('aria-current', () => (state().isActive ? 'page' : undefined), server)
  define(
    'class',
    () => stateClass(options, state().isActive, resolvedStateProps()),
    stylePlain,
  )
  define('style', () => stateStyle(options, resolvedStateProps()), stylePlain)

  if (readers) {
    const read = readers
    let snapshot: Record<string, unknown> | undefined
    return () => {
      if (!snapshot) {
        snapshot = {}
        for (const key in read) {
          const reader = read[key]!
          const value = reader === FORWARDED ? options[key] : reader()
          // What ssrElement would skip anyway; it still pays per key it walks.
          if (value != null && value !== false) snapshot[key] = value
        }
      }
      return snapshot
    }
  }
  return result
}

type LinkActions = ReturnType<typeof createLinkActions>

/**
 * What a link does when used: navigate, preload, cancel a pending preload.
 * Built on the first event that needs it, so rendering or hydrating a link
 * allocates none of it. Everything here reads the link's state untracked: it
 * runs in event handlers and effects, outside any tracking scope.
 */
function createLinkActions(
  router: AnyRouter,
  options: Record<string, any>,
  state: Solid.Accessor<LinkState>,
) {
  const peekPreload = () => Solid.untrack(state).preload
  const preloadDelay = () =>
    options.preloadDelay ?? router.options.defaultPreloadDelay ?? 0

  const doPreload = () =>
    router
      .preloadRoute({
        ...Solid.untrack(() => readRouteOptions(options)),
        _builtLocation: Solid.untrack(state).next,
      } as any)
      .catch((err: any) => {
        console.warn(err)
        console.warn(preloadWarning)
      })

  // Per-link identity for the preload timer.
  const timerKey = state

  const enqueuePreload = (
    e?: MouseEvent | FocusEvent | IntersectionObserverEntry,
  ) => {
    if (!e) {
      cancelPreload(timerKey)
      return
    }

    if (
      !(
        (e as IntersectionObserverEntry).isIntersecting ??
        peekPreload() === 'intent'
      )
    ) {
      if ((e as IntersectionObserverEntry).isIntersecting === false) {
        cancelPreload(timerKey)
      }
      return
    }

    if (!preloadDelay()) {
      doPreload()
      return
    }

    if (!timeoutMap.has(timerKey)) {
      timeoutMap.set(
        timerKey,
        setTimeout(() => {
          timeoutMap.delete(timerKey)
          doPreload()
        }, preloadDelay()),
      )
    }
  }

  const handleLeave = () => {
    if (peekPreload() === 'intent') {
      cancelPreload(timerKey)
    }
  }

  const handleClick = (e: MouseEvent) => {
    // Check actual element's target attribute as fallback
    const elementTarget = (
      e.currentTarget as HTMLAnchorElement | SVGAElement
    ).getAttribute('target')
    const effectiveTarget =
      options.target !== undefined ? options.target : elementTarget

    if (
      !options.disabled &&
      !isCtrlEvent(e) &&
      !e.defaultPrevented &&
      (!effectiveTarget || effectiveTarget === '_self') &&
      e.button === 0
    ) {
      e.preventDefault()

      // All is well? Navigate!
      // N.B. we don't call `router.commitLocation(next) here because we want to run `validateSearch` before committing
      router.navigate({
        ...Solid.untrack(() => readRouteOptions(options)),
        replace: options.replace,
        resetScroll: options.resetScroll,
        hashScrollIntoView: options.hashScrollIntoView,
        startTransition: options.startTransition,
        viewTransition: options.viewTransition,
        ignoreBlocker: options.ignoreBlocker,
      } as any)
    }
  }

  return {
    doPreload,
    enqueuePreload,
    handleClick,
    onBlur: handleLeave,
    onFocus: enqueuePreload,
    onMouseEnter: enqueuePreload,
    onMouseOver: enqueuePreload,
    onMouseLeave: handleLeave,
    onMouseOut: handleLeave,
    onTouchStart: () => {
      if (peekPreload() === 'intent') doPreload()
    },
  } satisfies Record<IntentKey, (event: any) => void> & Record<string, unknown>
}

function externalTo(to: unknown, router: AnyRouter) {
  if (isSafeInternal(to)) return undefined
  if (typeof to !== 'string' || to.indexOf(':') === -1) return undefined
  try {
    new URL(to)
    // Block dangerous protocols like javascript:, blob:, data:
    if (isDangerousProtocol(to, router.protocolAllowlist)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`Blocked Link with dangerous protocol: ${to}`)
      }
      return undefined
    }
    return to
  } catch {}
  return undefined
}

function testActive(
  activeOptions: Record<string, any> | undefined,
  current: ParsedLocation,
  nextLocation: ParsedLocation,
  router: AnyRouter,
  hideHash: boolean,
) {
  if (activeOptions?.exact) {
    const testExact = exactPathTest(
      current.pathname,
      nextLocation.pathname,
      router.basepath,
    )
    if (!testExact) {
      return false
    }
  } else {
    const currentPath = removeTrailingSlash(current.pathname, router.basepath)
    const nextPath = removeTrailingSlash(nextLocation.pathname, router.basepath)

    const pathIsFuzzyEqual =
      currentPath.startsWith(nextPath) &&
      (currentPath.length === nextPath.length ||
        currentPath[nextPath.length] === '/')
    if (!pathIsFuzzyEqual) {
      return false
    }
  }

  if (activeOptions?.includeSearch ?? true) {
    const searchTest = deepEqual(current.search, nextLocation.search, {
      partial: !activeOptions?.exact,
      ignoreUndefined: !activeOptions?.explicitUndefined,
    })
    if (!searchTest) {
      return false
    }
  }

  if (activeOptions?.includeHash) {
    const currentHash = hideHash ? '' : current.hash
    return currentHash === nextLocation.hash
  }
  return true
}

const STATIC_ACTIVE_PROPS = { class: 'active' }
const EMPTY_OBJECT = {}

/** Call a JSX.EventHandlerUnion with the event. */
function callHandler<T, TEvent extends Event>(
  event: TEvent & { currentTarget: T; target: Element },
  handler: JSX.EventHandlerUnion<T, TEvent>,
) {
  if (typeof handler === 'function') {
    handler(event)
  } else {
    handler[0](handler[1], event)
  }
  return event.defaultPrevented
}

function createComposedHandler<T, TEvent extends Event>(
  getHandler: () => JSX.EventHandlerUnion<T, TEvent> | undefined,
  fallback: (event: TEvent) => void,
) {
  return (event: TEvent & { currentTarget: T; target: Element }) => {
    const handler = getHandler()
    if (!handler || !callHandler(event, handler)) fallback(event)
  }
}

export type UseLinkPropsOptions<
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends RoutePaths<TRouter['routeTree']> | string = string,
  TTo extends string | undefined = '.',
  TMaskFrom extends RoutePaths<TRouter['routeTree']> | string = TFrom,
  TMaskTo extends string = '.',
> = ActiveLinkOptions<'a', TRouter, TFrom, TTo, TMaskFrom, TMaskTo> &
  Omit<ComponentProps<'a'>, 'style'> & { style?: JSX.CSSProperties }

export type ActiveLinkOptions<
  TComp = 'a',
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = '.',
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '.',
> = LinkOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> &
  ActiveLinkOptionProps<TComp>

type ActiveLinkProps<TComp> = Partial<
  LinkComponentSolidProps<TComp> & {
    [key: `data-${string}`]: unknown
  }
>

export interface ActiveLinkOptionProps<TComp = 'a'> {
  /**
   * A function that returns additional props for the `active` state of this link.
   * These props override other props passed to the link (`style`'s are merged, `class`'s are concatenated)
   */
  activeProps?: ActiveLinkProps<TComp> | (() => ActiveLinkProps<TComp>)
  /**
   * A function that returns additional props for the `inactive` state of this link.
   * These props override other props passed to the link (`style`'s are merged, `class`'s are concatenated)
   */
  inactiveProps?: ActiveLinkProps<TComp> | (() => ActiveLinkProps<TComp>)
}

export type LinkProps<
  TComp = 'a',
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = '.',
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '.',
> = ActiveLinkOptions<TComp, TRouter, TFrom, TTo, TMaskFrom, TMaskTo> &
  LinkPropsChildren

export interface LinkPropsChildren {
  // If a function is passed as a child, it will be given the `isActive` boolean to aid in further styling on the element it returns
  children?: JSX.Element | ((state: { isActive: boolean }) => JSX.Element)
}

type LinkComponentSolidProps<TComp> = TComp extends ValidComponent
  ? Omit<ComponentProps<TComp>, keyof CreateLinkProps>
  : never

export type LinkComponentProps<
  TComp = 'a',
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = '.',
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '.',
> = LinkComponentSolidProps<TComp> &
  LinkProps<TComp, TRouter, TFrom, TTo, TMaskFrom, TMaskTo>

export type CreateLinkProps = LinkProps<
  any,
  any,
  string,
  string,
  string,
  string
>

export type LinkComponent<
  in out TComp,
  in out TDefaultFrom extends string = string,
> = <
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = TDefaultFrom,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(
  props: LinkComponentProps<TComp, TRouter, TFrom, TTo, TMaskFrom, TMaskTo>,
) => JSX.Element

export interface LinkComponentRoute<
  in out TDefaultFrom extends string = string,
> {
  defaultFrom: TDefaultFrom;
  <
    TRouter extends AnyRouter = RegisteredRouter,
    const TTo extends string | undefined = undefined,
    const TMaskTo extends string = '',
  >(
    props: LinkComponentProps<
      'a',
      TRouter,
      this['defaultFrom'],
      TTo,
      this['defaultFrom'],
      TMaskTo
    >,
  ): JSX.Element
}

export function createLink<const TComp>(
  Comp: Constrain<TComp, any, (props: CreateLinkProps) => JSX.Element>,
): LinkComponent<TComp> {
  return (props) => <Link {...props} _asChild={Comp} />
}

export const Link: LinkComponent<'a'> = (props) => {
  const p = props as typeof props & { _asChild?: any }
  // An object, or on the server for a plain anchor the function that returns
  // it (see linkProps).
  const anchorProps = linkProps(p as Record<string, any>, true)
  const readAnchorProps = () =>
    typeof anchorProps === 'function' ? anchorProps() : anchorProps
  const renderProp = (ch: Function) =>
    ch({
      get isActive() {
        return readAnchorProps()['data-status'] === 'active'
      },
    })

  // A plain anchor reads the children getter once per run of its own child
  // slot, so it needs no children() memo: a render prop is called with the
  // link state, anything else is left for the slot to resolve.
  const children = () => {
    const ch = p.children
    if (typeof ch === 'function' && ch.length) return renderProp(ch)
    return ch
  }

  if (p._asChild === 'svg') {
    const svgLinkProps =
      typeof anchorProps === 'function'
        ? () => {
            const { class: _, ...rest } = anchorProps()
            return rest
          }
        : splitProps(anchorProps, ['class'])[1]
    return (
      <svg>
        <a {...svgLinkProps}>{children()}</a>
      </svg>
    )
  }

  if (!p._asChild) {
    return <a {...anchorProps}>{children()}</a>
  }

  // A host component may read `children` more than once, and each read of the
  // getter would build them again.
  const resolvedChildren = Solid.children(() => p.children as JSX.Element)
  const hostChildren = () => {
    const ch = resolvedChildren()
    if (typeof ch === 'function') return renderProp(ch)
    return ch
  }

  return (
    <Dynamic component={p._asChild as ValidComponent} {...anchorProps}>
      {hostChildren()}
    </Dynamic>
  )
}

function isCtrlEvent(e: MouseEvent) {
  return !!(e.metaKey || e.altKey || e.ctrlKey || e.shiftKey)
}

function isSafeInternal(to: unknown) {
  if (typeof to !== 'string') return false
  const zero = to.charCodeAt(0)
  if (zero === 47) return to.charCodeAt(1) !== 47 // '/' but not '//'
  return zero === 46 // '.', '..', './', '../'
}

export type LinkOptionsFnOptions<
  TOptions,
  TComp,
  TRouter extends AnyRouter = RegisteredRouter,
> =
  TOptions extends ReadonlyArray<any>
    ? ValidateLinkOptionsArray<TRouter, TOptions, string, TComp>
    : ValidateLinkOptions<TRouter, TOptions, string, TComp>

export type LinkOptionsFn<TComp> = <
  const TOptions,
  TRouter extends AnyRouter = RegisteredRouter,
>(
  options: LinkOptionsFnOptions<TOptions, TComp, TRouter>,
) => TOptions

export const linkOptions: LinkOptionsFn<'a'> = (options) => {
  return options as any
}
