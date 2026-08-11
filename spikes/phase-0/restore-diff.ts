/**
 * Spike 1 — Version restore: does naive delete-and-reinsert inside a single
 * transaction merge safely against a stale peer?
 *
 * Throwaway script. Not production code.
 */

import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utf8Len(bytes: Uint8Array): number {
  return bytes.length;
}

function docByteSize(doc: Y.Doc): number {
  return utf8Len(Y.encodeStateAsUpdate(doc));
}

/** Build a realistic nested block tree inside fragment */
function buildTree(fragment: Y.XmlFragment, doc: Y.Doc): void {
  doc.transact(() => {
    // Three top-level blocks, each with children
    for (let i = 0; i < 3; i++) {
      const para = new Y.XmlElement("paragraph");
      para.setAttribute("blockId", `b${i}`);
      para.setAttribute("createdAt", String(Date.now()));
      para.setAttribute("updatedAt", String(Date.now()));

      const text = new Y.XmlText();
      text.insert(0, `Block ${i} — initial content`);
      para.insert(0, [text]);

      // Two nested child blocks
      for (let j = 0; j < 2; j++) {
        const child = new Y.XmlElement("paragraph");
        child.setAttribute("blockId", `b${i}_${j}`);
        child.setAttribute("createdAt", String(Date.now()));
        child.setAttribute("updatedAt", String(Date.now()));
        const ctext = new Y.XmlText();
        ctext.insert(0, `  Child ${i}.${j}`);
        child.insert(0, [ctext]);
        para.insert(para.length, [child]);
      }

      fragment.insert(fragment.length, [para]);
    }
  });
}

/** Mutate the tree — simulates several editing rounds */
function mutate(fragment: Y.XmlFragment, doc: Y.Doc, label: string): void {
  doc.transact(() => {
    // Modify first block text
    const first = fragment.get(0) as Y.XmlElement;
    const text = first.get(0) as Y.XmlText;
    text.insert(text.length, ` [${label}]`);
    first.setAttribute("updatedAt", String(Date.now()));

    // Add a new top-level block
    const newBlock = new Y.XmlElement("paragraph");
    newBlock.setAttribute("blockId", `new_${label}`);
    newBlock.setAttribute("createdAt", String(Date.now()));
    newBlock.setAttribute("updatedAt", String(Date.now()));
    const t = new Y.XmlText();
    t.insert(0, `Added in round ${label}`);
    newBlock.insert(0, [t]);
    fragment.insert(fragment.length, [newBlock]);
  });
}

/** Serialize fragment content to a comparable string */
function serializeFragment(fragment: Y.XmlFragment): string {
  function serializeNode(node: Y.XmlElement | Y.XmlText): string {
    if (node instanceof Y.XmlText) {
      return node.toString();
    }
    const attrs = Object.entries(node.getAttributes())
      .filter(([k]) => k !== "updatedAt") // updatedAt changes on restore
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const children = Array.from({ length: node.length }, (_, i) =>
      serializeNode(node.get(i) as Y.XmlElement | Y.XmlText)
    ).join("|");
    return `<${node.nodeName}[${attrs}]>${children}</${node.nodeName}>`;
  }
  return Array.from({ length: fragment.length }, (_, i) =>
    serializeNode(fragment.get(i) as Y.XmlElement | Y.XmlText)
  ).join("\n");
}

/** Content equality ignoring updatedAt (which restore may touch) */
function fragmentsEqual(a: Y.XmlFragment, b: Y.XmlFragment): boolean {
  return serializeFragment(a) === serializeFragment(b);
}

// ---------------------------------------------------------------------------
// applyFragmentDiff — naive: clear and reinsert (the thing being tested)
// ---------------------------------------------------------------------------

function cloneElement(src: Y.XmlElement | Y.XmlText): Y.XmlElement | Y.XmlText {
  if (src instanceof Y.XmlText) {
    const t = new Y.XmlText();
    // Clone deltas
    const delta = src.toDelta();
    for (const op of delta) {
      if (typeof op.insert === "string") {
        t.insert(t.length, op.insert, op.attributes);
      }
    }
    return t;
  }
  const el = new Y.XmlElement(src.nodeName);
  const attrs = src.getAttributes();
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  for (let i = 0; i < src.length; i++) {
    el.insert(el.length, [cloneElement(src.get(i) as Y.XmlElement | Y.XmlText)]);
  }
  return el;
}

function applyFragmentDiff(live: Y.XmlFragment, historic: Y.XmlFragment): void {
  // Naive: delete all, reinsert from historic
  while (live.length > 0) {
    live.delete(0);
  }
  const clones: (Y.XmlElement | Y.XmlText)[] = [];
  for (let i = 0; i < historic.length; i++) {
    clones.push(cloneElement(historic.get(i) as Y.XmlElement | Y.XmlText));
  }
  if (clones.length > 0) {
    live.insert(0, clones);
  }
}

// ---------------------------------------------------------------------------
// Measurements helpers
// ---------------------------------------------------------------------------

function measureCreateFromSnapshot(
  doc: Y.Doc,
  snapshot: Y.Snapshot,
  opCount: number
): number {
  const start = performance.now();
  Y.createDocFromSnapshot(doc, snapshot);
  const elapsed = performance.now() - start;
  return elapsed;
}

function heapMB(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed / 1024 / 1024;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("=".repeat(70));
console.log("Spike 1 — Restore-diff");
console.log("=".repeat(70));

// ---------------------------------------------------------------------------
// Part A: Basic restore
// ---------------------------------------------------------------------------

console.log("\n--- Part A: Basic restore ---\n");

const doc = new Y.Doc({ gc: false });
const fragment = doc.getXmlFragment("blocks");

buildTree(fragment, doc);
const snap0Encoded = Y.encodeSnapshot(Y.snapshot(doc));
console.log("Snapshot 0 encoded bytes:", snap0Encoded.byteLength, "(after initial build)");
console.log("Doc state size:", docByteSize(doc), "bytes");

mutate(fragment, doc, "R1");
const snap1Encoded = Y.encodeSnapshot(Y.snapshot(doc));
console.log("Snapshot 1 encoded bytes:", snap1Encoded.byteLength, "(after round 1 mutation)");
console.log("Doc state size:", docByteSize(doc), "bytes");

mutate(fragment, doc, "R2");
const snap2Encoded = Y.encodeSnapshot(Y.snapshot(doc));
console.log("Snapshot 2 encoded bytes:", snap2Encoded.byteLength, "(after round 2 mutation)");
console.log("Doc state size:", docByteSize(doc), "bytes");

mutate(fragment, doc, "R3");
console.log("Doc state size after round 3:", docByteSize(doc), "bytes");

// Materialize historic from snapshot 1 (round-trip through encode/decode)
const snap1 = Y.decodeSnapshot(snap1Encoded);
const historic = Y.createDocFromSnapshot(doc, snap1);
const historicFragment = historic.getXmlFragment("blocks");

console.log("\nHistoric (snap1) content:\n", serializeFragment(historicFragment));
console.log("\nLive (current) content:\n", serializeFragment(fragment));

// Apply restore
doc.transact(() => {
  applyFragmentDiff(fragment, historicFragment);
}, "restore");

console.log("\nAfter restore content:\n", serializeFragment(fragment));

const restoredMatchesHistoric = fragmentsEqual(fragment, historicFragment);
console.log("\nRestored matches historic:", restoredMatchesHistoric ? "YES ✓" : "NO ✗");

// ---------------------------------------------------------------------------
// Part B: Two-device merge test
// ---------------------------------------------------------------------------

console.log("\n--- Part B: Two-device merge (stale peer, no unrelated edit) ---\n");

// Build a shared starting doc
const shared = new Y.Doc({ gc: false });
const sharedFrag = shared.getXmlFragment("blocks");
buildTree(sharedFrag, shared);
mutate(sharedFrag, shared, "shared1");

// Sync to device B before making more changes
const docA = new Y.Doc({ gc: false });
const docB = new Y.Doc({ gc: false });
Y.applyUpdate(docA, Y.encodeStateAsUpdate(shared));
Y.applyUpdate(docB, Y.encodeStateAsUpdate(shared));

// Capture snapshot on A while both are synced
const snapForRestore = Y.decodeSnapshot(Y.encodeSnapshot(Y.snapshot(docA)));

// Now disconnect. Mutate A further (these are what we'll restore FROM)
const fragA = docA.getXmlFragment("blocks");
mutate(fragA, docA, "A_extra1");
mutate(fragA, docA, "A_extra2");

const fragB = docB.getXmlFragment("blocks");

console.log("Before restore:");
console.log("  A content:", serializeFragment(fragA).split("\n").length, "blocks");
console.log("  B content:", serializeFragment(fragB).split("\n").length, "blocks");

// Take A's pre-restore state vector (B will apply A's updates)
const aStateBeforeRestore = Y.encodeStateAsUpdate(docA);

// Perform restore on A — goes back to snapForRestore
const historicA = Y.createDocFromSnapshot(docA, snapForRestore);
const historicFragA = historicA.getXmlFragment("blocks");

docA.transact(() => {
  applyFragmentDiff(fragA, historicFragA);
}, "restore");

const aUpdatesAfterRestore = Y.encodeStateAsUpdate(docA);

console.log("\nAfter restore on A:");
console.log("  A content:", serializeFragment(fragA).split("\n").length, "blocks");

// Apply A's updates to B, and B's stale state to A
Y.applyUpdate(docB, aUpdatesAfterRestore);
Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

console.log("\nAfter full sync (A→B and B→A):");
console.log("  A blocks:", serializeFragment(fragA).split("\n").length);
console.log("  B blocks:", serializeFragment(fragB).split("\n").length);

// Did content removed by restore survive on either side?
const aContent = serializeFragment(fragA);
const bContent = serializeFragment(fragB);

const removedContent = ["A_extra1", "A_extra2"];
let resurrectionDetectedA = false;
let resurrectionDetectedB = false;
for (const tag of removedContent) {
  if (aContent.includes(tag)) { resurrectionDetectedA = true; }
  if (bContent.includes(tag)) { resurrectionDetectedB = true; }
}

console.log("\nResurrection check (looking for A_extra1, A_extra2 after restore):");
console.log("  Resurrected on A:", resurrectionDetectedA ? "YES — PROBLEM" : "No ✓");
console.log("  Resurrected on B:", resurrectionDetectedB ? "YES — PROBLEM" : "No ✓");
console.log("  A and B converged:", aContent === bContent ? "YES ✓" : "NO ✗");

// ---------------------------------------------------------------------------
// Part C: Stale peer with an UNRELATED edit
// ---------------------------------------------------------------------------

console.log("\n--- Part C: Stale peer made an unrelated edit while disconnected ---\n");

const shared2 = new Y.Doc({ gc: false });
const sharedFrag2 = shared2.getXmlFragment("blocks");
buildTree(sharedFrag2, shared2);
mutate(sharedFrag2, shared2, "shared2_round1");

const docC = new Y.Doc({ gc: false }); // will do restore
const docD = new Y.Doc({ gc: false }); // stale peer with independent edit
Y.applyUpdate(docC, Y.encodeStateAsUpdate(shared2));
Y.applyUpdate(docD, Y.encodeStateAsUpdate(shared2));

const snapC = Y.decodeSnapshot(Y.encodeSnapshot(Y.snapshot(docC)));

// Disconnect. C mutates more, then restores to snapC. D makes an unrelated edit.
const fragC = docC.getXmlFragment("blocks");
const fragD = docD.getXmlFragment("blocks");

mutate(fragC, docC, "C_will_be_removed");

// D's unrelated independent edit: add text to a different block
docD.transact(() => {
  const second = fragD.get(1) as Y.XmlElement;
  const text = second.get(0) as Y.XmlText;
  text.insert(text.length, " [D_independent_edit]");
}, "D_edit");

// Restore C to snapC
const historicC = Y.createDocFromSnapshot(docC, snapC);
const historicFragC = historicC.getXmlFragment("blocks");

docC.transact(() => {
  applyFragmentDiff(fragC, historicFragC);
}, "restore");

// Sync: apply C's updates to D, D's updates to C
Y.applyUpdate(docD, Y.encodeStateAsUpdate(docC));
Y.applyUpdate(docC, Y.encodeStateAsUpdate(docD));

const cFinal = serializeFragment(fragC);
const dFinal = serializeFragment(fragD);

console.log("C final blocks:", serializeFragment(fragC).split("\n").length);
console.log("D final blocks:", serializeFragment(fragD).split("\n").length);
console.log("C and D converged:", cFinal === dFinal ? "YES ✓" : "NO ✗");

const dEditSurvivedC = cFinal.includes("D_independent_edit");
const dEditSurvivedD = dFinal.includes("D_independent_edit");
const cRemovedContentResurrected = cFinal.includes("C_will_be_removed");

console.log("\nD's independent edit survived on C:", dEditSurvivedC ? "YES ✓" : "NO — edit was lost");
console.log("D's independent edit survived on D:", dEditSurvivedD ? "YES ✓" : "NO — edit was lost");
console.log("C's removed content resurrected:", cRemovedContentResurrected ? "YES — PROBLEM" : "No ✓");

// ---------------------------------------------------------------------------
// Part D: createDocFromSnapshot on a gc:true doc
// ---------------------------------------------------------------------------

console.log("\n--- Part D: createDocFromSnapshot on gc:true doc ---\n");

const gcDoc = new Y.Doc({ gc: true });
const gcFrag = gcDoc.getXmlFragment("blocks");
buildTree(gcFrag, gcDoc);
const gcSnap = Y.decodeSnapshot(Y.encodeSnapshot(Y.snapshot(gcDoc)));
mutate(gcFrag, gcDoc, "gc_mutation");

// Delete some content so GC actually fires
gcDoc.transact(() => {
  gcFrag.delete(0);
});

// Force GC by re-applying state (GC runs on merge)
const gcUpdate = Y.encodeStateAsUpdate(gcDoc);
const gcDoc2 = new Y.Doc({ gc: true });
Y.applyUpdate(gcDoc2, gcUpdate);

try {
  const result = Y.createDocFromSnapshot(gcDoc2, gcSnap);
  const resultFrag = result.getXmlFragment("blocks");
  console.log("createDocFromSnapshot on gc:true doc succeeded — blocks:", resultFrag.length);
  console.log("(Silent wrong result is possible here — content may be incomplete)");
  // Check if the result is actually correct
  console.log("Result content:\n", serializeFragment(resultFrag));
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log("createDocFromSnapshot threw:", msg);
  console.log("(Failure is loud ✓)");
}

// ---------------------------------------------------------------------------
// Part E: Measurements
// ---------------------------------------------------------------------------

console.log("\n--- Part E: Measurements ---\n");

// Build docs with ~100, ~1000, ~10000 accumulated operations
// (one "operation" ≈ one transact containing one text insert)

type Measurement = {
  ops: number;
  docBytes: number;
  snapBytes: number;
  createMs: number;
  heapMBFresh: number;
  heapMBHeavy: number;
};

const measurements: Measurement[] = [];

for (const targetOps of [100, 1000, 10000]) {
  const d = new Y.Doc({ gc: false });
  const f = d.getXmlFragment("blocks");
  d.transact(() => {
    const el = new Y.XmlElement("paragraph");
    el.setAttribute("blockId", "seed");
    const t = new Y.XmlText();
    t.insert(0, "seed");
    el.insert(0, [t]);
    f.insert(0, [el]);
  });

  // Generate ~targetOps operations
  for (let i = 0; i < targetOps; i++) {
    d.transact(() => {
      const el = f.get(0) as Y.XmlElement;
      const t = el.get(0) as Y.XmlText;
      t.insert(t.length, `x`);
    });
  }

  const snap = Y.snapshot(d);
  const snapBytes = Y.encodeSnapshot(snap).byteLength;
  const docBytes = docByteSize(d);

  // Measure heap before
  global.gc?.();
  const heapBefore = heapMB();

  const createMs = measureCreateFromSnapshot(d, snap, targetOps);

  // Measure heap: gc:false heavy editing doc
  const heavyDoc = new Y.Doc({ gc: false });
  const heavyFrag = heavyDoc.getXmlFragment("blocks");
  heavyDoc.transact(() => {
    const el = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, "seed");
    el.insert(0, [t]);
    heavyFrag.insert(0, [el]);
  });
  for (let i = 0; i < targetOps; i++) {
    heavyDoc.transact(() => {
      const el = heavyFrag.get(0) as Y.XmlElement;
      const t = el.get(0) as Y.XmlText;
      t.insert(t.length, "x");
    });
  }
  global.gc?.();
  const heapAfterHeavy = heapMB();

  // Fresh doc with same logical content
  const freshDoc = new Y.Doc({ gc: false });
  const freshFrag = freshDoc.getXmlFragment("blocks");
  const finalText = (
    (heavyFrag.get(0) as Y.XmlElement).get(0) as Y.XmlText
  ).toString();
  freshDoc.transact(() => {
    const el = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, finalText);
    el.insert(0, [t]);
    freshFrag.insert(0, [el]);
  });
  global.gc?.();
  const heapAfterFresh = heapMB();

  measurements.push({
    ops: targetOps,
    docBytes,
    snapBytes,
    createMs: Math.round(createMs * 100) / 100,
    heapMBFresh: Math.round((heapAfterFresh - heapBefore) * 10) / 10,
    heapMBHeavy: Math.round((heapAfterHeavy - heapBefore) * 10) / 10,
  });
}

console.log("Ops\t| Doc bytes\t| Snap bytes\t| createFromSnap ms\t| Heap heavy MB\t| Heap fresh MB");
console.log("-".repeat(90));
for (const m of measurements) {
  console.log(
    `${m.ops}\t| ${m.docBytes}\t| ${m.snapBytes}\t| ${m.createMs}\t\t\t| ${m.heapMBHeavy}\t\t| ${m.heapMBFresh}`
  );
}

console.log("\n=== Done ===");
