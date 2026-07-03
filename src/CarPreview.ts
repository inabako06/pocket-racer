import * as THREE from "three";
import { AssetGenerator } from "./AssetGenerator";
import { getCarSpec } from "./CarRoster";
import { CAR } from "./Constants";

/**
 * 車選択カード内に各車の 3D モデルを表示する。
 * カードにマウスオーバーするとその車が横（Y軸）に回転し、全周を見られる。
 * 各カードの `<canvas class="car-3d">` にそれぞれ小さな WebGL レンダラを割り当て、
 * `#car-select` が表示されている間だけ描画する（非表示中は休止）。
 */
interface Preview {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pivot: THREE.Group; // 車をまとめて Y 回転させる入れ物
  hovered: boolean;
}

export function initCarPreviews(container: HTMLElement): void {
  const previews: Preview[] = [];

  for (const card of Array.from(container.querySelectorAll<HTMLElement>(".car-card"))) {
    const canvas = card.querySelector<HTMLCanvasElement>("canvas.car-3d");
    if (!canvas) continue;
    const spec = getCarSpec(card.dataset.car ?? "lion");

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0x9fb0c8, 1.05));
    const sun = new THREE.DirectionalLight(0xfff2cc, 1.0);
    sun.position.set(6, 10, 7);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-7, 4, 8);
    scene.add(fill);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 1.1, 6.0);
    camera.lookAt(0, -0.05, 0);

    const pivot = new THREE.Group();
    pivot.rotation.y = -0.6; // 既定はフロント3/4の見え
    scene.add(pivot);

    // 車体＋4輪（実機と同じ見た目タイヤ高さ）
    pivot.add(AssetGenerator.createCarBody(spec));
    const k = spec.wheelScale ?? 1.0;
    const R = CAR.WHEEL_RADIUS;
    const wheelY = -0.437 - R * (1 - k);
    for (const sx of [-CAR.WHEEL_X, CAR.WHEEL_X]) {
      for (const sz of [CAR.WHEEL_Z, -CAR.WHEEL_Z]) {
        const w = AssetGenerator.createWheel(spec.rimColor);
        w.scale.setScalar(k);
        w.position.set(sx, wheelY, sz);
        pivot.add(w);
      }
    }

    const preview: Preview = { renderer, scene, camera, pivot, hovered: false };
    previews.push(preview);
    card.addEventListener("pointerenter", () => { preview.hovered = true; });
    card.addEventListener("pointerleave", () => { preview.hovered = false; });
  }

  // canvas の表示サイズにレンダラ／カメラを追従させる
  function fit(p: Preview): void {
    const c = p.renderer.domElement;
    const w = c.clientWidth, h = c.clientHeight;
    if (w === 0 || h === 0) return;
    const pr = p.renderer.getPixelRatio();
    if (c.width !== Math.round(w * pr) || c.height !== Math.round(h * pr)) {
      p.renderer.setSize(w, h, false);
      p.camera.aspect = w / h;
      p.camera.updateProjectionMatrix();
    }
  }

  const clock = new THREE.Clock();
  function loop(): void {
    requestAnimationFrame(loop);
    if (container.classList.contains("hidden")) return; // 非表示中は描画しない
    const dt = Math.min(clock.getDelta(), 0.05);
    for (const p of previews) {
      fit(p);
      // ホバー中は回転。非ホバー時は既定角へゆっくり戻す。
      if (p.hovered) {
        p.pivot.rotation.y += dt * 1.7;
      } else {
        const target = -0.6;
        let d = ((target - p.pivot.rotation.y) % (Math.PI * 2));
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        p.pivot.rotation.y += d * Math.min(1, dt * 4);
      }
      p.renderer.render(p.scene, p.camera);
    }
  }
  loop();
}
