// Core (works without React). Worker files import their tasks from './workers/builtins' directly,
// so worker-only code never ends up in the page's bundle.
export {
  WorkerPool,
  TaskCancelledError,
  WorkerTaskError,
  WorkerCrashedError,
  isCancelled,
  defaultPoolSize,
} from './core/worker-pool';
export { defineWorker } from './core/worker-runtime';
export { collectTransferables, share } from './core/transfer';
export { detectCapabilities } from './core/capabilities';
export { yieldToMain, whenIdle } from './core/scheduler';
export { keyOf, idOf, Memo, cached } from './core/memo';
export { isAbort } from './core/util';
export { prepareRows, queryRows } from './data/query';
export { Engine } from './smart/engine';
export { KERNELS } from './smart/kernels';
export { OPS, defineOp, ranges, piece } from './smart/ops';
export { DEFAULT_IMAGE_PARAMS } from './gpu/params';
export { clearThumbnailCache } from './image/imageLoader';

// React
export { createNativeCompute } from './react/createNativeCompute';
export { VirtualList } from './react/VirtualList';
export { useLatestTask, useAsyncAction, useNearScreen, useElementSize } from './react/hooks';
export { useWillChange, LazySection, auditGpuCss, useGpuCssAudit } from './react/gpuCss';

// Navigation
export {
  Router,
  lazy,
  useRouter,
  useLocation,
  useParams,
  useLoaderData,
  useNavigation,
  useHead,
  loadRoute,
  routeHead,
} from './router/router';
export { buildHead, headToHtml, applyHead, serializeData } from './router/head.mjs';
export { Link, NavigationProgress, DelayedIndicator, useDelayedFlag } from './router/ui';
export { registerServiceWorker, unregisterServiceWorker } from './addons/registerServiceWorker';
export { Sheet, Carousel } from './react/native';

// Automatic native feel, accessibility and fallbacks (started by the Provider and Router)
export { autoNative, stopAutoNative, isLite } from './core/auto';
export { auditA11y } from './core/a11yAudit';
export { announce } from './router/router';
export { nativeFeelCss } from './styles/nativeFeelCss';
