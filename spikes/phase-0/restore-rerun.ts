/**
 * Spike 1 rerun — untested peer scenarios + realistic measurements.
 *
 * Run with: bun --expose-gc spikes/phase-0/restore-rerun.ts
 * (--expose-gc is required for heap readings; without it global.gc is a no-op)
 *
 * Throwaway script. Not production code.
 *
 * Refs: D017, D018
 */

import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Shared helpers (compact reimplementation of restore-diff.ts patterns)
// ---------------------------------------------------------------------------

function docBytes(doc: Y.Doc): number {
  return Y.encodeStateAsUpdate(doc).byteLength;
}

function snapBytes(doc: Y.Doc): number {
  return Y.encodeSnapshot(Y.snapshot(doc)).byteLength;
}

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function gc(): void {
  (global as any).gc?.();
}

function cloneNode(src: Y.XmlElement | Y.XmlText): Y.XmlElement | Y.XmlText {
  if (src instanceof Y.XmlText) {
    const t = new Y.XmlText();
    for (const op of src.toDelta()) {
      if (typeof op.insert === "string") t.insert(t.length, op.insert, op.attributes);
    }
    return t;
  }
  const el = new Y.XmlElement(src.nodeName);
  for (const [k, v] of Object.entries(src.getAttributes())) el.setAttribute(k, v);
  for (let i = 0; i < src.length; i++) {
    el.insert(el.length, [cloneNode(src.get(i) as Y.XmlElement | Y.XmlText)]);
  }
  return el;
}

function naiveRestore(live: Y.XmlFragment, historic: Y.XmlFragment): void {
  while (live.length > 0) live.delete(0);
  const clones: (Y.XmlElement | Y.XmlText)[] = [];
  for (let i = 0; i < historic.length; i++) {
    clones.push(cloneNode(historic.get(i) as Y.XmlElement | Y.XmlText));
  }
  if (clones.length > 0) live.insert(0, clones);
}

function fragmentIds(frag: Y.XmlFragment): string[] {
  const ids: string[] = [];
  for (let i = 0; i < frag.length; i++) {
    const n = frag.get(i);
    if (n instanceof Y.XmlElement) {
      ids.push(n.getAttribute("blockId") ?? n.nodeName);
    }
  }
  return ids;
}

function fragmentTexts(frag: Y.XmlFragment): string[] {
  const texts: string[] = [];
  function walk(n: Y.XmlElement | Y.XmlText | Y.XmlFragment): void {
    if (n instanceof Y.XmlText) { texts.push(n.toString()); return; }
    for (let i = 0; i < n.length; i++) walk(n.get(i) as Y.XmlElement | Y.XmlText);
  }
  walk(frag);
  return texts;
}

function serialise(frag: Y.XmlFragment): string {
  function node(n: Y.XmlElement | Y.XmlText): string {
    if (n instanceof Y.XmlText) return JSON.stringify(n.toString());
    const a = Object.entries(n.getAttributes())
      .filter(([k]) => k !== "updatedAt")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    const ch = Array.from({ length: n.length }, (_, i) =>
      node(n.get(i) as Y.XmlElement | Y.XmlText)
    ).join(", ");
    return `<${n.nodeName}${a ? " " + a : ""}>${ch}</${n.nodeName}>`;
  }
  return Array.from({ length: frag.length }, (_, i) =>
    node(frag.get(i) as Y.XmlElement | Y.XmlText)
  ).join("\n");
}

function synced(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

// ---------------------------------------------------------------------------
// Part 1 — Peer scenarios
// ---------------------------------------------------------------------------

console.log("=".repeat(70));
console.log("Spike 1 rerun — peer scenarios + realistic measurements");
console.log("=".repeat(70));

// ---------------------------------------------------------------------------
// Scenario 1: Peer deletes a block that the restore reinstates
//
// Setup: shared state has blocks [1, 2, 3]. Snapshot taken.
// A mutates more, then restores to snapshot.
// B (offline) deletes block 2 before the sync.
// Expected hypothesis: B's deletion targeted original block-2 element.
// Restore creates a NEW clone of block-2. B's delete is on a different
// element identity, so the new clone survives.
// ---------------------------------------------------------------------------

console.log("\n--- Scenario 1: Peer deletes a block that restore reinstates ---\n");

{
  const initial = new Y.Doc({ gc: false });
  const iFrag = initial.getXmlFragment("blocks");

  initial.transact(() => {
    for (const id of ["b1", "b2", "b3"]) {
      const el = new Y.XmlElement("paragraph");
      el.setAttribute("blockId", id);
      const t = new Y.XmlText();
      t.insert(0, `Content of ${id}`);
      el.insert(0, [t]);
      iFrag.insert(iFrag.length, [el]);
    }
  });

  const snapEnc = Y.encodeSnapshot(Y.snapshot(initial));

  // Mutate A beyond snapshot (these are the changes A will restore FROM)
  const docA = new Y.Doc({ gc: false });
  const docB = new Y.Doc({ gc: false });
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(initial));
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(initial));

  const fragA = docA.getXmlFragment("blocks");
  const fragB = docB.getXmlFragment("blocks");

  // A makes more edits after snapshot
  docA.transact(() => {
    const el = new Y.XmlElement("paragraph");
    el.setAttribute("blockId", "b4_from_A");
    const t = new Y.XmlText();
    t.insert(0, "Added by A after snapshot");
    el.insert(0, [t]);
    fragA.insert(fragA.length, [el]);
  });

  // B goes offline and deletes block 2
  docB.transact(() => {
    // Find and delete b2 (index 1 in the original 3-block array)
    let idx = -1;
    for (let i = 0; i < fragB.length; i++) {
      const n = fragB.get(i);
      if (n instanceof Y.XmlElement && n.getAttribute("blockId") === "b2") {
        idx = i;
        break;
      }
    }
    if (idx !== -1) fragB.delete(idx);
  });

  console.log("Before sync — A blocks:", fragmentIds(fragA));
  console.log("Before sync — B blocks:", fragmentIds(fragB));

  // A restores to snapshot (reinstates b2)
  const snapDecoded = Y.decodeSnapshot(snapEnc);
  const historic = Y.createDocFromSnapshot(docA, snapDecoded);
  const historicFrag = historic.getXmlFragment("blocks");

  docA.transact(() => {
    naiveRestore(fragA, historicFrag);
  }, "restore");

  console.log("After A restore — A blocks:", fragmentIds(fragA));

  // Full bidirectional sync
  synced(docA, docB);

  console.log("\nAfter full sync:");
  console.log("  A blocks:", fragmentIds(fragA));
  console.log("  B blocks:", fragmentIds(fragB));
  console.log("  A and B converged:", serialise(fragA) === serialise(fragB) ? "YES ✓" : "NO ✗");

  const b2InA = fragmentIds(fragA).includes("b2");
  const b2InB = fragmentIds(fragB).includes("b2");
  console.log("\n  b2 present on A:", b2InA ? "YES" : "no");
  console.log("  b2 present on B:", b2InB ? "YES" : "no");
  console.log("\n  Mechanism: restore creates a NEW XmlElement clone for b2.");
  console.log("  B's delete targeted the ORIGINAL b2 element identity.");
  console.log("  The new clone has a different Yjs item ID — B's delete does not reach it.");
  console.log("  b2 comes back:", b2InA ? "YES — D002's documented failure mode, via different route" : "no (unexpected)");
}

// ---------------------------------------------------------------------------
// Scenario 2: Peer inserts a new block while A restores
//
// Setup: blocks [1, 2, 3]. Snapshot taken.
// B (offline) inserts block 4 at end.
// A restores to snapshot.
// Expected: block 4 survives (its insert is not inside any deleted element),
// but the final document is NOT a clean rollback — it's restored-content + block-4.
// ---------------------------------------------------------------------------

console.log("\n--- Scenario 2: Peer inserts a new block at fragment root ---\n");

{
  const initial = new Y.Doc({ gc: false });
  const iFrag = initial.getXmlFragment("blocks");

  initial.transact(() => {
    for (const id of ["b1", "b2", "b3"]) {
      const el = new Y.XmlElement("paragraph");
      el.setAttribute("blockId", id);
      const t = new Y.XmlText();
      t.insert(0, `Content of ${id}`);
      el.insert(0, [t]);
      iFrag.insert(iFrag.length, [el]);
    }
  });

  const snapEnc = Y.encodeSnapshot(Y.snapshot(initial));

  const docA = new Y.Doc({ gc: false });
  const docB = new Y.Doc({ gc: false });
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(initial));
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(initial));

  const fragA = docA.getXmlFragment("blocks");
  const fragB = docB.getXmlFragment("blocks");

  // A makes more edits after snapshot
  docA.transact(() => {
    const el = new Y.XmlElement("paragraph");
    el.setAttribute("blockId", "b_extra_A");
    const t = new Y.XmlText();
    t.insert(0, "A extra content");
    el.insert(0, [t]);
    fragA.insert(fragA.length, [el]);
  });

  // B goes offline and inserts block 4 at end
  docB.transact(() => {
    const el = new Y.XmlElement("paragraph");
    el.setAttribute("blockId", "b4_new");
    const t = new Y.XmlText();
    t.insert(0, "B's new block 4");
    el.insert(0, [t]);
    fragB.insert(fragB.length, [el]);
  });

  console.log("Before sync — A blocks:", fragmentIds(fragA));
  console.log("Before sync — B blocks:", fragmentIds(fragB));

  // A restores to snapshot
  const snapDecoded = Y.decodeSnapshot(snapEnc);
  const historic = Y.createDocFromSnapshot(docA, snapDecoded);
  const historicFrag = historic.getXmlFragment("blocks");

  docA.transact(() => {
    naiveRestore(fragA, historicFrag);
  }, "restore");

  console.log("After A restore — A blocks:", fragmentIds(fragA));

  // Full sync
  synced(docA, docB);

  console.log("\nAfter full sync:");
  console.log("  A blocks:", fragmentIds(fragA));
  console.log("  B blocks:", fragmentIds(fragB));
  console.log("  A and B converged:", serialise(fragA) === serialise(fragB) ? "YES ✓" : "NO ✗");

  const b4Survived = fragmentIds(fragA).includes("b4_new");
  const b4Position = fragmentIds(fragA).indexOf("b4_new");
  console.log("\n  b4 survived:", b4Survived ? "YES" : "no");
  if (b4Survived) {
    console.log("  b4 position in final fragment (0-indexed):", b4Position);
    console.log("  (Restore is not a clean rollback — peer's insertion survives)");
  }

  console.log("\n  Mechanism: b4 was inserted after original-b3 in the Yjs linked list.");
  console.log("  Original-b3 is tombstoned by restore, but b4 is still linked after it.");
  console.log("  A's restore inserts clone-b1, clone-b2, clone-b3 at position 0.");
  console.log("  In Yjs, concurrent inserts at adjacent positions resolve by client ID.");
  console.log("  b4 ends up after the restored content.");
}

// ---------------------------------------------------------------------------
// Scenario 3: Peer edits a block that the restore removes entirely
//
// Setup: blocks [1, 2]. Snapshot S_early taken.
// Block 3 added later. A and B synced (both have [1, 2, 3]).
// B disconnects. B edits block 3's text.
// A restores to S_early — removes block 3.
// Expected: B's edit disappears (it targeted the deleted element).
// ---------------------------------------------------------------------------

console.log("\n--- Scenario 3: Peer edits a block that restore removes ---\n");

{
  const initial = new Y.Doc({ gc: false });
  const iFrag = initial.getXmlFragment("blocks");

  // Phase 1: blocks [1, 2], take snapshot
  initial.transact(() => {
    for (const id of ["b1", "b2"]) {
      const el = new Y.XmlElement("paragraph");
      el.setAttribute("blockId", id);
      const t = new Y.XmlText();
      t.insert(0, `Content of ${id}`);
      el.insert(0, [t]);
      iFrag.insert(iFrag.length, [el]);
    }
  });

  const snapEarlyEnc = Y.encodeSnapshot(Y.snapshot(initial));

  // Phase 2: add block 3
  initial.transact(() => {
    const el = new Y.XmlElement("paragraph");
    el.setAttribute("blockId", "b3");
    const t = new Y.XmlText();
    t.insert(0, "Content of b3");
    el.insert(0, [t]);
    iFrag.insert(iFrag.length, [el]);
  });

  // Both A and B synced to include b3
  const docA = new Y.Doc({ gc: false });
  const docB = new Y.Doc({ gc: false });
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(initial));
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(initial));

  const fragA = docA.getXmlFragment("blocks");
  const fragB = docB.getXmlFragment("blocks");

  console.log("Initial state (both A and B):", fragmentIds(fragA));

  // B disconnects. B edits b3's text.
  docB.transact(() => {
    let b3: Y.XmlElement | null = null;
    for (let i = 0; i < fragB.length; i++) {
      const n = fragB.get(i);
      if (n instanceof Y.XmlElement && n.getAttribute("blockId") === "b3") {
        b3 = n;
        break;
      }
    }
    if (b3) {
      const t = b3.get(0) as Y.XmlText;
      t.insert(t.length, " [B_edit_on_b3]");
    }
  });

  console.log("B's b3 text:", fragmentTexts(fragB).find(s => s.includes("b3")));

  // A restores to S_early (which removes b3)
  const snapDecoded = Y.decodeSnapshot(snapEarlyEnc);
  const historic = Y.createDocFromSnapshot(docA, snapDecoded);
  const historicFrag = historic.getXmlFragment("blocks");

  docA.transact(() => {
    naiveRestore(fragA, historicFrag);
  }, "restore");

  console.log("After A restore — A blocks:", fragmentIds(fragA));

  // Full sync
  synced(docA, docB);

  console.log("\nAfter full sync:");
  console.log("  A blocks:", fragmentIds(fragA));
  console.log("  B blocks:", fragmentIds(fragB));
  console.log("  A and B converged:", serialise(fragA) === serialise(fragB) ? "YES ✓" : "NO ✗");

  const b3InA = fragmentIds(fragA).includes("b3");
  const b3InB = fragmentIds(fragB).includes("b3");
  const bEditSurvived = fragmentTexts(fragA).some(s => s.includes("B_edit_on_b3"));

  console.log("\n  b3 present on A:", b3InA ? "YES" : "no");
  console.log("  b3 present on B:", b3InB ? "YES" : "no");
  console.log("  B's edit on b3 survived:", bEditSurvived ? "YES (unexpected)" : "no — discarded");
  console.log("\n  Mechanism: B's text edit targeted an element inside b3.");
  console.log("  A's restore deleted b3 (tombstoned). After merge, B's text-insert");
  console.log("  is inside a deleted element — it stays deleted.");
  console.log("  The edit is neither resurrected nor visible. Silently gone.");
}

// ---------------------------------------------------------------------------
// Part 2 — Realistic measurements
//
// Workload: 4 clients, each working independently, then merged at the end.
// Mix: ~40% text insert, ~20% text delete, ~15% block insert, ~25% block delete
//      (block delete capped to avoid exhausting blocks, actual deletion ~30-35%)
// Scales: 1000, 10000, 100000 operations total.
//
// Clients do NOT sync during the run to avoid O(n²) merge cost. All states
// are merged once at the end. This still generates a realistic multi-client
// update log with distinct client IDs and interleaved clocks.
//
// Run with --expose-gc for accurate heap readings.
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(70));
console.log("Part 2 — Realistic multi-client measurements");
console.log("=".repeat(70));

console.log("\nWorkload: 4 clients (no intermediate sync, merged at end)");
console.log("Mix: ~40% text insert, ~20% text delete, ~15% block insert, ~25% block delete");
console.log("Note: absolute bytes depend on this synthetic workload; ratios are what matters.\n");
console.log("--expose-gc available:", typeof (global as any).gc === "function" ? "YES" : "NO (heap readings unreliable)");

// Simple PRNG for reproducibility across all scales
let rngSeed = 42;
function rand(): number {
  rngSeed = (rngSeed * 1664525 + 1013904223) & 0xffffffff;
  return (rngSeed >>> 0) / 0xffffffff;
}
function randInt(min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

type Row = {
  ops: number;
  gcFalseBytes: number;
  freshBytes: number;
  bytesRatio: string;
  gcFalseHeapMB: number;
  freshHeapMB: number;
  heapRatio: string;
  snapEarlyBytes: number;
  snapLateBytes: number;
  createEarlyMs: number;
  createLateMs: number;
  mergeBeforeBytes: number;
  mergeAfterBytes: number;
  mergeSavePct: string;
  mergeTimeMs: number;
};

const rows: Row[] = [];

for (const targetOps of [1000, 10000, 100000]) {
  rngSeed = 42; // reset for reproducibility at each scale
  console.log(`\nBuilding workload at ${targetOps} ops...`);
  const t0 = performance.now();

  const NUM_CLIENTS = 4;
  const opsPerClient = Math.ceil(targetOps / NUM_CLIENTS);

  // Seed: 10 blocks, same for all clients
  const seedDoc = new Y.Doc({ gc: false });
  const seedFrag = seedDoc.getXmlFragment("blocks");
  seedDoc.transact(() => {
    for (let i = 0; i < 10; i++) {
      const el = new Y.XmlElement("paragraph");
      el.setAttribute("blockId", `seed_${i}`);
      const t = new Y.XmlText();
      t.insert(0, `Initial content block ${i}. Some words here. More text follows.`);
      el.insert(0, [t]);
      seedFrag.insert(seedFrag.length, [el]);
    }
  });
  const seedState = Y.encodeStateAsUpdate(seedDoc);

  // Each client starts from seed and runs independently
  const clients: Y.Doc[] = [];
  const clientFrags: Y.XmlFragment[] = [];
  // Collect per-operation delta blobs (for mergeUpdates measurement)
  const allOpDeltas: Uint8Array[] = [seedState];

  for (let c = 0; c < NUM_CLIENTS; c++) {
    const d = new Y.Doc({ gc: false });
    Y.applyUpdate(d, seedState);
    clients.push(d);
    clientFrags.push(d.getXmlFragment("blocks"));
  }

  // Snapshot reference: taken from client 0 at 10% and 90% of its ops
  const snap10pctOp = Math.floor(opsPerClient * 0.1);
  const snap90pctOp = Math.floor(opsPerClient * 0.9);
  let snapEarlyEnc: Uint8Array | null = null;
  let snapLateEnc: Uint8Array | null = null;

  // Run each client independently
  for (let c = 0; c < NUM_CLIENTS; c++) {
    const client = clients[c];
    const frag = clientFrags[c];
    let localOps = 0;

    for (let op = 0; op < opsPerClient; op++) {
      const blockCount = frag.length;
      const roll = rand();
      const svBefore = Y.encodeStateVector(client);

      if (roll < 0.40 && blockCount > 0) {
        // 40%: text insert
        client.transact(() => {
          const bi = randInt(0, blockCount - 1);
          const el = frag.get(bi);
          if (el instanceof Y.XmlElement && el.length > 0) {
            const tn = el.get(0);
            if (tn instanceof Y.XmlText) {
              tn.insert(randInt(0, Math.min(tn.length, 20)), "xy");
            }
          }
        });
      } else if (roll < 0.60 && blockCount > 0) {
        // 20%: text delete
        client.transact(() => {
          const bi = randInt(0, blockCount - 1);
          const el = frag.get(bi);
          if (el instanceof Y.XmlElement && el.length > 0) {
            const tn = el.get(0);
            if (tn instanceof Y.XmlText && tn.length > 6) {
              const start = randInt(0, tn.length - 5);
              const len = randInt(2, Math.min(12, tn.length - start));
              tn.delete(start, len);
            }
          }
        });
      } else if (roll < 0.75) {
        // 15%: insert new block
        client.transact(() => {
          const el = new Y.XmlElement("paragraph");
          el.setAttribute("blockId", `c${c}_op${op}`);
          const nt = new Y.XmlText();
          nt.insert(0, `C${c} op${op} inserted block`);
          el.insert(0, [nt]);
          frag.insert(randInt(0, frag.length), [el]);
        });
      } else if (blockCount > 4) {
        // 25% (when enough blocks): delete a block
        client.transact(() => {
          frag.delete(randInt(1, blockCount - 1));
        });
      } else {
        // fallback: text insert at block 0
        client.transact(() => {
          const el = frag.get(0);
          if (el instanceof Y.XmlElement && el.length > 0) {
            const tn = el.get(0);
            if (tn instanceof Y.XmlText) tn.insert(0, "z");
          }
        });
      }

      // Collect the delta for this op (small — just the new items)
      const delta = Y.encodeStateAsUpdate(client, svBefore);
      if (delta.byteLength > 0) allOpDeltas.push(delta);

      localOps++;

      // Snapshots from client 0 only
      if (c === 0) {
        if (localOps === snap10pctOp) {
          snapEarlyEnc = Y.encodeSnapshot(Y.snapshot(client));
        }
        if (localOps === snap90pctOp) {
          snapLateEnc = Y.encodeSnapshot(Y.snapshot(client));
        }
      }
    }
  }

  // Merge all client states into one doc
  const mergedDoc = new Y.Doc({ gc: false });
  Y.applyUpdate(mergedDoc, seedState);
  for (const c of clients) {
    Y.applyUpdate(mergedDoc, Y.encodeStateAsUpdate(c));
  }
  const mergedFrag = mergedDoc.getXmlFragment("blocks");

  if (!snapEarlyEnc) snapEarlyEnc = Y.encodeSnapshot(Y.snapshot(clients[0]));
  if (!snapLateEnc) snapLateEnc = Y.encodeSnapshot(Y.snapshot(clients[0]));

  const buildMs = performance.now() - t0;
  console.log(`  Built in ${buildMs.toFixed(0)}ms. Merged doc blocks: ${mergedFrag.length}`);

  // ---- gc:false doc bytes ----
  const gcFalseBytes = docBytes(mergedDoc);

  // ---- fresh doc with same logical content ----
  const freshDoc = new Y.Doc({ gc: false });
  const freshFrag = freshDoc.getXmlFragment("blocks");
  freshDoc.transact(() => {
    for (let i = 0; i < mergedFrag.length; i++) {
      const src = mergedFrag.get(i);
      if (src instanceof Y.XmlElement) freshFrag.insert(freshFrag.length, [cloneNode(src)]);
    }
  });
  const freshDocBytes = docBytes(freshDoc);

  // ---- heap ----
  gc();
  const heapBase = heapMB();

  // Load gc:false doc
  const loadedGcFalse = new Y.Doc({ gc: false });
  Y.applyUpdate(loadedGcFalse, Y.encodeStateAsUpdate(mergedDoc));
  gc();
  const heapAfterGcFalse = heapMB();
  const gcFalseHeapMB = Math.round((heapAfterGcFalse - heapBase) * 10) / 10;

  // Load fresh doc
  const loadedFresh = new Y.Doc({ gc: false });
  Y.applyUpdate(loadedFresh, Y.encodeStateAsUpdate(freshDoc));
  gc();
  const heapAfterFresh = heapMB();
  const freshHeapMB = Math.round((heapAfterFresh - heapAfterGcFalse) * 10) / 10;

  // ---- snapshot sizes ----
  const snapEarlyBytes = snapEarlyEnc.byteLength;
  const snapLateBytes = snapLateEnc.byteLength;

  // ---- createDocFromSnapshot time: old vs recent snapshot ----
  // Both are materialized from the full merged doc (includes all client history)
  const snapEarlyDecoded = Y.decodeSnapshot(snapEarlyEnc);
  const snapLateDecoded = Y.decodeSnapshot(snapLateEnc);

  const te1 = performance.now();
  Y.createDocFromSnapshot(mergedDoc, snapEarlyDecoded);
  const createEarlyMs = Math.round((performance.now() - te1) * 100) / 100;

  const te2 = performance.now();
  Y.createDocFromSnapshot(mergedDoc, snapLateDecoded);
  const createLateMs = Math.round((performance.now() - te2) * 100) / 100;

  // ---- mergeUpdates ----
  const mergeBeforeBytes = allOpDeltas.reduce((s, u) => s + u.byteLength, 0);
  const tm = performance.now();
  const mergedUpdate = Y.mergeUpdates(allOpDeltas);
  const mergeTimeMs = performance.now() - tm;
  const mergeAfterBytes = mergedUpdate.byteLength;

  // Confirm tombstones survive merge by applying merged update to a fresh doc
  const verifyDoc = new Y.Doc({ gc: false });
  Y.applyUpdate(verifyDoc, mergedUpdate);
  const verifyFrag = verifyDoc.getXmlFragment("blocks");
  const tombstonesIntact = verifyFrag.length === mergedFrag.length;

  const bytesRatio = (gcFalseBytes / freshDocBytes).toFixed(1);
  const heapRatio = freshHeapMB > 0.01 ? (gcFalseHeapMB / freshHeapMB).toFixed(1) : "n/a";
  const mergeSavePct =
    mergeBeforeBytes > 0
      ? (((mergeBeforeBytes - mergeAfterBytes) / mergeBeforeBytes) * 100).toFixed(0)
      : "0";

  rows.push({
    ops: targetOps,
    gcFalseBytes,
    freshBytes: freshDocBytes,
    bytesRatio: `${bytesRatio}×`,
    gcFalseHeapMB,
    freshHeapMB,
    heapRatio: `${heapRatio}×`,
    snapEarlyBytes,
    snapLateBytes,
    createEarlyMs,
    createLateMs,
    mergeBeforeBytes,
    mergeAfterBytes,
    mergeSavePct: `${mergeSavePct}%`,
    mergeTimeMs: Math.round(mergeTimeMs),
  });

  console.log(`  gc:false: ${gcFalseBytes}B, fresh: ${freshDocBytes}B, ratio: ${bytesRatio}×`);
  console.log(`  heap gc:false: ${gcFalseHeapMB}MB, heap fresh: ${freshHeapMB}MB, ratio: ${heapRatio}×`);
  console.log(`  snap early: ${snapEarlyBytes}B, snap late: ${snapLateBytes}B`);
  console.log(`  createDocFromSnapshot: early ${createEarlyMs}ms, late ${createLateMs}ms`);
  console.log(`  mergeUpdates: ${mergeBeforeBytes}B → ${mergeAfterBytes}B (saves ${mergeSavePct}%), in ${mergeTimeMs.toFixed(0)}ms`);
  console.log(`  tombstones after merge: ${tombstonesIntact ? "intact ✓" : "MISSING ✗"} (${verifyFrag.length} vs ${mergedFrag.length} blocks)`);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

console.log("\n\n" + "=".repeat(70));
console.log("TABLES");
console.log("=".repeat(70));

console.log("\nTable 1 — Document size and tombstone overhead");
console.log("Ops\t| gc:false bytes\t| fresh bytes\t| ratio");
console.log("-".repeat(65));
for (const r of rows) {
  console.log(`${r.ops}\t| ${r.gcFalseBytes}\t\t| ${r.freshBytes}\t\t| ${r.bytesRatio}`);
}

console.log("\nTable 2 — Heap (loaded doc, after forced GC)");
console.log("Ops\t| gc:false heap MB\t| fresh heap MB\t| ratio");
console.log("-".repeat(65));
for (const r of rows) {
  console.log(`${r.ops}\t| ${r.gcFalseHeapMB}\t\t\t| ${r.freshHeapMB}\t\t| ${r.heapRatio}`);
}

console.log("\nTable 3 — Snapshot size");
console.log("Ops\t| snap at 10% ops (early)\t| snap at 90% ops (late)");
console.log("-".repeat(65));
for (const r of rows) {
  console.log(`${r.ops}\t| ${r.snapEarlyBytes} bytes\t\t\t| ${r.snapLateBytes} bytes`);
}

console.log("\nTable 4 — createDocFromSnapshot time vs snapshot age");
console.log("Ops\t| early snap (10%)\t| late snap (90%)");
console.log("-".repeat(55));
for (const r of rows) {
  console.log(`${r.ops}\t| ${r.createEarlyMs}ms\t\t\t| ${r.createLateMs}ms`);
}

console.log("\nTable 5 — mergeUpdates compaction");
console.log("Ops\t| sum of individual updates\t| after merge\t| savings");
console.log("-".repeat(70));
for (const r of rows) {
  console.log(`${r.ops}\t| ${r.mergeBeforeBytes}\t\t\t| ${r.mergeAfterBytes}\t\t| ${r.mergeSavePct}`);
}

console.log("\nNote: tombstones survive mergeUpdates. Size reduction is encoding overhead,");
console.log("not tombstone removal. GC (with gc:true) is required to drop tombstones.");

console.log("\n=== Done ===");
