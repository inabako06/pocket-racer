/**
 * キーボード入力を抽象化する。
 * 各クラスは生の KeyboardEvent ではなく、ここが公開する状態を参照する。
 * スマホのタッチ操作（TouchControls）は virtualInput 経由でここにマージされる。
 */

/**
 * タッチ操作ボタン（TouchControls.ts）が書き込む仮想入力。
 * Input はキーボードとこの状態を OR して返すので、Game 側はデバイスを意識しない。
 */
export const virtualInput = {
  accel: false,
  brake: false,
  steerLeft: false,
  steerRight: false,
  /** エッジ系（1回消費で false に戻る） */
  cameraToggle: false,
  pauseToggle: false,
  muteToggle: false,
  /** 何かタッチ操作があったか（オーディオ開始の判定に使う） */
  anyTouch: false,
};

/**
 * 1フレームで参照される操作状態。
 * 左手（Z/X）でアクセル・ブレーキ、右手（← →）でステアリングという
 * 両手分担の配置にしている。
 */
export interface InputState {
  /** アクセル（Z） */
  accel: boolean;
  /** ブレーキ・バック（X） */
  brake: boolean;
  /** 左ステア（←） */
  steerLeft: boolean;
  /** 右ステア（→） */
  steerRight: boolean;
}

export class Input {
  private readonly keys = new Set<string>();

  /** 押した瞬間に1回だけ反応させたいキー（カメラ切替など）のキュー */
  private readonly pressedOnce = new Set<string>();

  /** カメラ切替要求（C） */
  cameraToggleRequested = false;
  /** ポーズ切替要求（Esc） */
  pauseToggleRequested = false;
  /** ミュート切替要求（M） */
  muteToggleRequested = false;
  /** これまでに何かキー入力があったか（キーボードのみ。タッチは virtualInput） */
  private anyKey = false;

  /** これまでに何か入力（キー or タッチ）があったか（オーディオ開始の判定に使う） */
  get anyKeyPressed(): boolean {
    return this.anyKey || virtualInput.anyTouch;
  }

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // ゲーム用キーはブラウザの既定動作（スクロール等）を抑制
    if (this.isGameKey(e.code)) e.preventDefault();
    this.anyKey = true;

    // 押しっぱなしの keydown 連射では once 系を1回だけにする
    if (!this.keys.has(e.code)) {
      this.pressedOnce.add(e.code);
    }
    this.keys.add(e.code);

    // エッジ検出（押した瞬間）
    if (this.pressedOnce.has(e.code)) {
      switch (e.code) {
        case "KeyC":
          this.cameraToggleRequested = true;
          break;
        case "Escape":
          this.pauseToggleRequested = true;
          break;
        case "KeyM":
          this.muteToggleRequested = true;
          break;
      }
      this.pressedOnce.delete(e.code);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private isGameKey(code: string): boolean {
    return (
      code === "ArrowUp" ||
      code === "ArrowDown" ||
      code === "ArrowLeft" ||
      code === "ArrowRight" ||
      code === "Space"
    );
  }

  /** 連続押下を反映した操作状態を返す（キーボード OR タッチボタン） */
  getState(): InputState {
    return {
      accel: this.keys.has("KeyZ") || virtualInput.accel,
      brake: this.keys.has("KeyX") || virtualInput.brake,
      steerLeft: this.keys.has("ArrowLeft") || virtualInput.steerLeft,
      steerRight: this.keys.has("ArrowRight") || virtualInput.steerRight,
    };
  }

  /**
   * エッジ系フラグ（リセット/カメラ/ポーズ/ミュート）を読み取り、消費する。
   * Game のループ末尾で1回呼ぶ。
   */
  consumeEdgeFlags(): {
    cameraToggle: boolean;
    pauseToggle: boolean;
    muteToggle: boolean;
  } {
    const result = {
      cameraToggle: this.cameraToggleRequested || virtualInput.cameraToggle,
      pauseToggle: this.pauseToggleRequested || virtualInput.pauseToggle,
      muteToggle: this.muteToggleRequested || virtualInput.muteToggle,
    };
    this.cameraToggleRequested = false;
    this.pauseToggleRequested = false;
    this.muteToggleRequested = false;
    virtualInput.cameraToggle = false;
    virtualInput.pauseToggle = false;
    virtualInput.muteToggle = false;
    return result;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }
}
