// Reconcile a device's localStorage highlight cache with the server copy.
// Highlights sync per (user, store_key); both sides carry the base-content
// hash (stale content invalidates) and a timestamp (last-write-wins). Pure so
// it's unit-testable without the DOM or network.

export type LocalHl = { h: string; doc: unknown; t?: number } | null;
export type ServerHl = { content_hash: string; doc_json: string; updated_at: number } | null;

export type Pick =
	| { source: "none" }
	| { source: "local"; pushToServer: boolean }
	| { source: "server" };

export function pickHighlight(local: LocalHl, server: ServerHl, baseHash: string): Pick {
	const localValid = !!local && local.h === baseHash;
	const serverValid = !!server && server.content_hash === baseHash;

	if (!localValid && !serverValid) return { source: "none" };
	if (localValid && !serverValid) return { source: "local", pushToServer: true };
	if (!localValid && serverValid) return { source: "server" };

	// Both valid — newest wins. Legacy local entries (no t) count as 0.
	const lt = local!.t ?? 0;
	const st = server!.updated_at ?? 0;
	if (lt >= st) return { source: "local", pushToServer: lt > st };
	return { source: "server" };
}
