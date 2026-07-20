/// <reference lib="webworker" />
// Placeholder — replaced in Milestone 2 with the Access-aware worker.
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
