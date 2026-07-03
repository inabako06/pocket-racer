import * as THREE from "three";
import { SMOKE, COLOR } from "./Constants";
import { AssetGenerator } from "./AssetGenerator";

/** 1パーティクルの状態 */
interface Puff {
  sprite: THREE.Sprite;
  life: number; // 残り寿命(秒)
  vy: number; // 上昇速度
  vx: number; // 横へ広がる速度
  vz: number;
  spin: number; // スプライトの回転速度(rad/s)
}

/**
 * タイヤスモーク（ドリフト/スピン時の煙）。
 * スプライトのプールを使い回し、滑っている車輪の位置から白い煙を噴く。
 * もくもくと立ち上る煙のイメージ。
 */
export class TireSmoke {
  private readonly puffs: Puff[] = [];
  private next = 0;

  constructor(scene: THREE.Scene) {
    const texture = AssetGenerator.createSmokeTexture();
    for (let i = 0; i < SMOKE.MAX_PARTICLES; i++) {
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: COLOR.SMOKE,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: true,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.scale.setScalar(SMOKE.START_SIZE);
      scene.add(sprite);
      this.puffs.push({ sprite, life: 0, vy: 0, vx: 0, vz: 0, spin: 0 });
    }
  }

  /**
   * 指定位置から煙を1つ発生させる（プールから再利用）。
   * color を渡すとその色に染める（オフロードの土煙など）。省略時は通常の白煙。
   */
  emit(x: number, y: number, z: number, color: number = COLOR.SMOKE): void {
    const puff = this.puffs[this.next];
    this.next = (this.next + 1) % this.puffs.length;

    puff.sprite.material.color.setHex(color);
    // タイヤのすぐそばから出す（散らしすぎるとタイヤから離れて見えるので控えめ）
    puff.sprite.position.set(
      x + (Math.random() - 0.5) * 0.3,
      y + Math.random() * 0.12,
      z + (Math.random() - 0.5) * 0.3
    );
    puff.sprite.scale.setScalar(SMOKE.START_SIZE);
    puff.sprite.material.rotation = Math.random() * Math.PI * 2;
    puff.sprite.visible = true;
    puff.life = SMOKE.LIFETIME;
    puff.vy = SMOKE.RISE_SPEED * (0.7 + Math.random() * 0.6);
    // 接地点から外側へ広がる初速（左右ランダム）＋ゆっくり回転
    puff.vx = (Math.random() - 0.5) * 2 * SMOKE.SPREAD_SPEED;
    puff.vz = (Math.random() - 0.5) * 2 * SMOKE.SPREAD_SPEED;
    puff.spin = (Math.random() - 0.5) * 2.5;
  }

  /** 生存中の煙を更新（上昇・横拡散・拡大・回転・フェード） */
  update(dt: number): void {
    for (const puff of this.puffs) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      if (puff.life <= 0) {
        puff.sprite.visible = false;
        puff.sprite.material.opacity = 0;
        continue;
      }
      const t = 1 - puff.life / SMOKE.LIFETIME; // 0→1
      puff.sprite.position.y += puff.vy * dt;
      puff.sprite.position.x += puff.vx * dt;
      puff.sprite.position.z += puff.vz * dt;
      // 広がりは時間とともに減衰（空気抵抗っぽく）
      puff.vx *= 1 - 1.5 * dt;
      puff.vz *= 1 - 1.5 * dt;
      puff.sprite.material.rotation += puff.spin * dt;
      puff.sprite.scale.setScalar(
        THREE.MathUtils.lerp(SMOKE.START_SIZE, SMOKE.END_SIZE, t)
      );
      // 序盤に立ち上がり、終盤で消える山なりの不透明度
      puff.sprite.material.opacity = SMOKE.MAX_OPACITY * Math.sin(t * Math.PI);
    }
  }
}
