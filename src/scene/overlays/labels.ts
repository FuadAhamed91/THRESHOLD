import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export type LabelTone = 'neutral' | 'route' | 'conflict' | 'clear' | 'estimate' | 'caution';

// Cream chips over the night scene: saturated borders, deep tone-matched text.
const TONE_BORDER: Record<LabelTone, string> = {
  neutral: 'rgb(74 58 34 / 0.28)',
  route: '#2f6fe4',
  conflict: '#d0384c',
  clear: '#14905f',
  estimate: '#c48a0a',
  caution: '#d0800a',
};
const TONE_TEXT: Record<LabelTone, string> = {
  neutral: '#1f1b16',
  route: '#1d4ea8',
  conflict: '#9e1f31',
  clear: '#0d6a45',
  estimate: '#7a5604',
  caution: '#85500a',
};

/** Floating HTML label anchored in 3D (always readable, never occluded). */
export class SceneLabel {
  readonly object: CSS2DObject;
  readonly el: HTMLDivElement;
  private titleEl: HTMLSpanElement;
  private subEl: HTMLSpanElement;

  constructor(tone: LabelTone = 'neutral', big = false) {
    this.el = document.createElement('div');
    this.el.className = 'label-chip';
    this.el.style.transition = 'opacity 0.35s ease, border-color 0.3s ease';
    this.el.style.display = 'flex';
    this.el.style.flexDirection = 'column';
    this.el.style.alignItems = 'center';
    this.el.style.gap = '1px';
    this.titleEl = document.createElement('span');
    this.subEl = document.createElement('span');
    this.subEl.style.fontSize = '10px';
    this.subEl.style.opacity = '0.72';
    if (big) {
      this.titleEl.style.fontSize = '15px';
      this.titleEl.style.fontWeight = '600';
      this.el.style.padding = '5px 10px';
    }
    this.el.append(this.titleEl, this.subEl);
    this.object = new CSS2DObject(this.el);
    this.object.center.set(0.5, 1);
    this.setTone(tone);
  }

  set(title: string, sub = ''): this {
    if (this.titleEl.textContent !== title) this.titleEl.textContent = title;
    if (this.subEl.textContent !== sub) this.subEl.textContent = sub;
    this.subEl.style.display = sub ? 'block' : 'none';
    return this;
  }

  setTone(tone: LabelTone): this {
    this.el.style.borderColor = TONE_BORDER[tone];
    this.el.style.color = TONE_TEXT[tone];
    return this;
  }

  private enabled = true;
  private opacity = 0;

  setOpacity(o: number): void {
    this.opacity = o;
    const shown = this.enabled ? o : 0;
    this.el.style.opacity = String(shown);
    this.object.visible = shown > 0.01;
  }

  /** Per-act editorial control on top of the layer fade (avoids label pile-ups). */
  setEnabled(v: boolean): void {
    this.enabled = v;
    this.setOpacity(this.opacity);
  }
}
