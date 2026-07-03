import * as THREE from "three";
import { CAMERA } from "./Constants";
import { CarTuning } from "./CarTuning";
import type { CarDynamics } from "./Car";

/** カメラモード（C キーで循環切替） */
export enum CameraMode {
  Chase = 0, // 後方追従
  High = 1, // 少し高い位置
  Hood = 2, // ボンネット視点
}

const MODE_ORDER: CameraMode[] = [
  CameraMode.Chase,
  CameraMode.High,
  CameraMode.Hood,
];
const MODE_LABEL: Record<CameraMode, string> = {
  [CameraMode.Chase]: "CHASE",
  [CameraMode.High]: "HIGH",
  [CameraMode.Hood]: "HOOD",
};

/**
 * 車を追従するカメラ。車体に固定せず、CarTuning に従って
 * 遅れて追従・ブレーキで前寄り・ドリフトで外振り・速度でFOV変化＋揺れ、
 * といったアーケード的なスピード演出を行う。
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  private mode: CameraMode = CameraMode.Chase;
  private currentFov: number;

  // 作業用
  private readonly desiredPos = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly yawQuat = new THREE.Quaternion();
  private readonly upAxis = new THREE.Vector3(0, 1, 0);

  constructor(aspect: number) {
    this.currentFov = CarTuning.FOV;
    this.camera = new THREE.PerspectiveCamera(
      this.currentFov,
      aspect,
      CAMERA.NEAR,
      CAMERA.FAR
    );
    this.camera.position.set(0, CarTuning.CameraHeight, -CarTuning.CameraDistance);
  }

  toggle(): void {
    const idx = MODE_ORDER.indexOf(this.mode);
    this.mode = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
  }

  getModeLabel(): string {
    return MODE_LABEL[this.mode];
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 追従更新。
   * @param target 追従対象（車の root）
   * @param dyn 車の動的状態（速度/加減速/ドリフト）。スピード演出に使う
   * @param dt フレーム時間
   * @param snap true で補間せず即座に配置（リセット直後）
   */
  update(
    target: THREE.Object3D,
    dyn: CarDynamics,
    _dt: number,
    snap = false
  ): void {
    // モード別の基本オフセット（ローカル）
    if (this.mode === CameraMode.Chase) {
      this.offset.set(0, CarTuning.CameraHeight, -CarTuning.CameraDistance);
      // ブレーキ（減速）で前へ寄る：減速量に応じて距離を詰める
      const dive = Math.max(0, -dyn.accel) * CarTuning.CameraBrakeDive;
      this.offset.z += dive;
      // ドリフト/横滑りで外側へ振る
      this.offset.x += dyn.driftSwing * CarTuning.CameraDriftSwing;
    } else if (this.mode === CameraMode.High) {
      this.offset.set(CAMERA.HIGH_OFFSET.x, CAMERA.HIGH_OFFSET.y, CAMERA.HIGH_OFFSET.z);
    } else {
      this.offset.set(CAMERA.HOOD_OFFSET.x, CAMERA.HOOD_OFFSET.y, CAMERA.HOOD_OFFSET.z);
    }

    // ローカル → ワールド。
    // Chase/High は「進行方向(cameraYaw)」基準で回り込む（ドリフトで車体が横を
    // 向いてもカメラは進行方向の後方を保つ）。Hood は車体の向きに追従。
    if (this.mode === CameraMode.Hood) {
      this.offset.applyQuaternion(target.quaternion);
    } else {
      this.yawQuat.setFromAxisAngle(this.upAxis, dyn.cameraYaw);
      this.offset.applyQuaternion(this.yawQuat);
    }
    this.desiredPos.copy(target.position).add(this.offset);

    if (this.mode === CameraMode.Hood || snap) {
      this.camera.position.copy(this.desiredPos);
    } else {
      // CameraLag：小さいほど遅れて追従（加速時に後ろへ伸び、ジャンプも遅れる）
      this.camera.position.lerp(this.desiredPos, CarTuning.CameraLag);
    }

    // 高速時の微振動（スピード感）
    if (this.mode !== CameraMode.Hood) {
      const shake = CarTuning.CameraShake * dyn.speedNorm;
      this.camera.position.x += (Math.random() - 0.5) * shake;
      this.camera.position.y += (Math.random() - 0.5) * shake;
    }

    // 注視点
    this.lookTarget.copy(target.position);
    this.lookTarget.y += CAMERA.LOOK_HEIGHT;
    if (this.mode === CameraMode.Hood) {
      const forward = new THREE.Vector3(0, 0, 6).applyQuaternion(target.quaternion);
      this.lookTarget.add(forward);
    }
    this.camera.lookAt(this.lookTarget);

    // 速度に応じて FOV を広げる（スピード感の主役）
    const targetFov = CarTuning.FOV + CarTuning.FovBoost * dyn.speedNorm;
    this.currentFov += (targetFov - this.currentFov) * 0.1;
    if (Math.abs(this.currentFov - this.camera.fov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }
  }
}
