import { Vector2 } from 'three';

export interface InputFrame {
  move: Vector2;
  walk: boolean;
  sprint: boolean;
  jumpPressed: boolean;
  resetPressed: boolean;
  debugPressed: boolean;
}

export class InputController {
  readonly move = new Vector2();
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private wheelDelta = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onLockChange: (locked: boolean) => void,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.handleLockChange);
  }

  requestCapture(): void {
    void this.canvas.requestPointerLock();
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  sample(): InputFrame {
    const horizontal = Number(this.held.has('KeyD')) - Number(this.held.has('KeyA'));
    const forward = Number(this.held.has('KeyW')) - Number(this.held.has('KeyS'));
    this.move.set(horizontal, forward);
    if (this.move.lengthSq() > 1) this.move.normalize();

    const frame: InputFrame = {
      move: this.move.clone(),
      walk: this.held.has('ControlLeft') || this.held.has('ControlRight'),
      sprint: this.held.has('ShiftLeft') || this.held.has('ShiftRight'),
      jumpPressed: this.pressed.has('Space'),
      resetPressed: this.pressed.has('KeyR'),
      debugPressed: this.pressed.has('Backquote'),
    };
    this.pressed.clear();
    return frame;
  }

  consumeLook(): Vector2 {
    const result = new Vector2(this.lookX, this.lookY);
    this.lookX = 0;
    this.lookY = 0;
    return result;
  }

  consumeWheel(): number {
    const value = this.wheelDelta;
    this.wheelDelta = 0;
    return value;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'KeyF' && !event.repeat) {
      event.preventDefault();
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void document.documentElement.requestFullscreen();
      }
      return;
    }
    if (!this.held.has(event.code)) this.pressed.add(event.code);
    this.held.add(event.code);
    if (['Space', 'ControlLeft', 'ControlRight'].includes(event.code)) event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.pressed.clear();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.lookX += event.movementX;
    this.lookY += event.movementY;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.wheelDelta += event.deltaY;
  };

  private readonly handleLockChange = (): void => {
    this.onLockChange(this.locked);
  };
}
