/**
 * サウンド全体（BGM＋エンジン音＋効果音）のミュート状態の単一ソース。
 *
 * 既定はミュート。スマホでページを開いただけで、バックグラウンド再生中の
 * 音楽（別アプリ）を止めないため：iOS では AudioContext を作成/再開した時点で
 * オーディオセッションを奪ってしまうので、ゲイン 0 では不十分。
 * ユーザーが SND ボタン（または M キー）で解除するまで AudioContext を
 * 一切作らない（EngineSound.start / MusicPlayer.play がこの状態でゲートする）。
 *
 * アーケードモードのコース間 location.reload() を跨いで保持するため
 * sessionStorage に保存する（タブを閉じれば既定のミュートへ戻る）。
 */
const KEY = "pocket-muted";

let muted = sessionStorage.getItem(KEY) !== "0";
const listeners = new Set<(m: boolean) => void>();

export function isMuted(): boolean {
  return muted;
}

export function setGlobalMuted(m: boolean): void {
  if (muted === m) return;
  muted = m;
  sessionStorage.setItem(KEY, m ? "1" : "0");
  for (const fn of listeners) fn(m);
}

export function toggleGlobalMuted(): boolean {
  setGlobalMuted(!muted);
  return muted;
}

/** 状態変化の購読（SND ボタンの表示更新などに使う） */
export function onMuteChange(fn: (m: boolean) => void): void {
  listeners.add(fn);
}
