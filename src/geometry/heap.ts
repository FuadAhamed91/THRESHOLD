/** Binary min-heap of (node, priority) pairs on typed arrays. Lazy deletion is the caller's job. */
export class MinHeap {
  private nodes: Int32Array;
  private keys: Float64Array;
  private count = 0;

  constructor(capacity = 1024) {
    this.nodes = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(node: number, key: number): void {
    if (this.count === this.nodes.length) this.grow();
    let i = this.count++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.nodes[i] = this.nodes[parent];
      this.keys[i] = this.keys[parent];
      i = parent;
    }
    this.nodes[i] = node;
    this.keys[i] = key;
  }

  /** Removes and returns the node with the smallest key. Undefined behaviour when empty. */
  pop(): number {
    const top = this.nodes[0];
    const last = --this.count;
    if (last > 0) {
      const node = this.nodes[last];
      const key = this.keys[last];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= last) break;
        const r = l + 1;
        const c = r < last && this.keys[r] < this.keys[l] ? r : l;
        if (this.keys[c] >= key) break;
        this.nodes[i] = this.nodes[c];
        this.keys[i] = this.keys[c];
        i = c;
      }
      this.nodes[i] = node;
      this.keys[i] = key;
    }
    return top;
  }

  private grow(): void {
    const nodes = new Int32Array(this.nodes.length * 2);
    const keys = new Float64Array(this.keys.length * 2);
    nodes.set(this.nodes);
    keys.set(this.keys);
    this.nodes = nodes;
    this.keys = keys;
  }
}
