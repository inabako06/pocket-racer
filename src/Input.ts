/**
 * キーボード入力を抽象化する。
 * 各クラスは生の KeyboardEvent ではなく、ここが公開する状態を参照する。
 */

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
  /** これまでに何かキー入力があったか（オーディオ開始の判定に使う） */
  anyKeyPressed = false;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // ゲーム用キーはブラウザの既定動作（スクロール等）を抑制
    if (this.isGameKey(e.code)) e.preventDefault();
    this.anyKeyPressed = true;

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

  /** 連続押下を反映した操作状態を返す */
  getState(): InputState {
    return {
      accel: this.keys.has("KeyZ"),
      brake: this.keys.has("KeyX"),
      steerLeft: this.keys.has("ArrowLeft"),
      steerRight: this.keys.has("ArrowRight"),
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
      cameraToggle: this.cameraToggleRequested,
      pauseToggle: this.pauseToggleRequested,
      muteToggle: this.muteToggleRequested,
    };
    this.cameraToggleRequested = false;
    this.pauseToggleRequested = false;
    this.muteToggleRequested = false;
    return result;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }
}
