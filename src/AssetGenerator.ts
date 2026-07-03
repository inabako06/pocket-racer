import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { CAR, COLOR } from "./Constants";
import type { CarSpec } from "./CarRoster";

/**
 * すべての見た目アセットをプリミティブ／Canvasから生成するユーティリティ。
 * 外部モデル・画像は一切読み込まない（PS1風の自前生成）。
 */
export class AssetGenerator {
  /** Lambert マテリアルを手早く作る（フラットシェーディングでローポリ感） */
  static lambert(color: number, flat = true): THREE.MeshLambertMaterial {
    return new THREE.MeshLambertMaterial({ color, flatShading: flat });
  }

  /**
   * 256x256 のアスファルト風テクスチャ（ノイズ）。
   * NearestFilter でドット感を強調する。
   */
  static createAsphaltTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#4a4a52";
    ctx.fillRect(0, 0, size, size);

    // ざらつきノイズ
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const v = 60 + Math.floor(Math.random() * 40);
      ctx.fillStyle = `rgb(${v},${v},${v + 6})`;
      ctx.fillRect(x, y, 2, 2);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  /** 256x256 の芝風テクスチャ */
  static createGrassTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#4f8f3f";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 3000; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const g = 110 + Math.floor(Math.random() * 70);
      ctx.fillStyle = `rgb(${40 + Math.random() * 30},${g},${50})`;
      ctx.fillRect(x, y, 3, 3);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  /**
   * デフォルメしたトイカー風の車体（箱の組み合わせ）。
   * 返す Group の原点は車体（シャシー）の中心。y は車体中心が 0。
   * spec.style に応じて 5 車種のシルエットを作り分ける（色は spec の body/accent）。
   */
  static createCarBody(spec?: CarSpec): THREE.Group {
    const style = spec?.style ?? "lion";
    const bodyColor = spec?.bodyColor ?? COLOR.CAR_BODY;
    const accentColor = spec?.accentColor ?? COLOR.CAR_STRIPE;
    switch (style) {
      case "hawk":
        return AssetGenerator.buildHawk(bodyColor, accentColor);
      case "whale":
        return AssetGenerator.buildWhale(bodyColor, accentColor);
      case "piranha":
        return AssetGenerator.buildPiranha(bodyColor, accentColor);
      case "wyvern":
        return AssetGenerator.buildWyvern(bodyColor, accentColor);
      default:
        return AssetGenerator.buildLion(bodyColor, accentColor);
    }
  }

  /**
   * 車体ビルダー共通の道具一式（グループ・マテリアル・箱/丸ヘルパー）。
   * 各車種ビルダーは必要なものだけ分割代入で取り出して組み立てる。
   */
  private static kit(bodyColor: number, accentColor: number) {
    const group = new THREE.Group();
    const mats = {
      body: AssetGenerator.lambert(bodyColor),
      accent: AssetGenerator.lambert(accentColor, false),
      window: AssetGenerator.lambert(COLOR.CAR_WINDOW, false),
      bumper: AssetGenerator.lambert(COLOR.CAR_BUMPER, false),
      grille: AssetGenerator.lambert(COLOR.CAR_GRILLE, false),
      chrome: AssetGenerator.lambert(COLOR.CAR_CHROME, false),
      signal: AssetGenerator.lambert(COLOR.CAR_SIGNAL, false),
      tail: AssetGenerator.lambert(COLOR.CAR_TAIL, false),
      head: AssetGenerator.lambert(COLOR.CAR_HEADLIGHT, false),
    };
    // 角の丸い箱（トイカーらしい丸み）
    const rbox = (
      w: number, h: number, d: number, r: number,
      x: number, y: number, z: number, mat: THREE.Material
    ): THREE.Mesh => {
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat);
      m.position.set(x, y, z);
      group.add(m);
      return m;
    };
    // 角ばった小物
    const box = (
      w: number, h: number, d: number,
      x: number, y: number, z: number, mat: THREE.Material
    ): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      group.add(m);
      return m;
    };
    // 前向き円盤（ヘッドライト/テール用）
    const disc = (
      r: number, depth: number, x: number, y: number, z: number, mat: THREE.Material
    ): THREE.Mesh => {
      const g = new THREE.CylinderGeometry(r, r, depth, 12).rotateX(Math.PI / 2);
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, y, z);
      group.add(m);
      return m;
    };
    // フェンダーアーチ（四隅・タイヤ強調）
    const arches = (zFront: number = CAR.WHEEL_Z, zRear: number = -CAR.WHEEL_Z): void => {
      for (const sx of [-0.86, 0.86]) {
        for (const sz of [zFront, zRear]) {
          rbox(0.46, 0.52, 1.25, 0.22, sx, -0.04, sz, mats.body);
        }
      }
    };
    // デュアルマフラー
    const exhaust = (z: number): void => {
      const g = new THREE.CylinderGeometry(0.08, 0.08, 0.18, 8).rotateX(Math.PI / 2);
      for (const sx of [-0.2, 0.2]) {
        const p = new THREE.Mesh(g, AssetGenerator.lambert(COLOR.CAR_EXHAUST, false));
        p.position.set(sx, -0.46, z);
        group.add(p);
      }
    };
    return { group, mats, rbox, box, disc, arches, exhaust };
  }

  /**
   * レッドライオン（lion）のプロポーション。角ばった赤いラリー風の車体
   * ＝箱形ボディ・直立キャビン・白2本ストライプ（ボンネット→屋根→ハッチ）・
   * ボンネットスクープ・丸目2灯（十字レンズ）・黒スリットグリル・琥珀フォグ・
   * 角ばった赤フェンダーフレア・中空三角の大型ウイング・大径ブロックタイヤ。
   * **リファインはここだけ触れば形が変わる**。
   */
  static LION = {
    halfW: 0.96, // 車体半幅
    cabinW: 0.86, // キャビン半幅
    floor: -0.86, // 車体フロア（車高＝地面クリアランス）
    belt: 0.46, // ベルトライン（窓下）＝高め
    noseZ: 1.54, // ノーズ最前（ほぼ垂直の前面）
    hoodY: 0.3, // ボンネット前端の高さ
    cowlZ: 0.58, // カウル（フロントガラス根本Z）
    wsTopZ: 0.16, // フロントガラス上端Z（中程度のラケ）
    roofY: 1.04, // ルーフ（ガラス上端Y）＝背の高い直立キャビン
    roofRearZ: -0.88, // ルーフ後端Z
    rglassZ: -1.18, // リアガラス下端Z（ハッチ肩）
    hatchTopZ: -1.44, // ハッチ上端Z（わずかに前傾した垂直ハッチ）
    tailZ: -1.5, // リア最後端Z
    wheelCY: -0.497, // 見た目タイヤ中心Y（0.9スケールの大径タイヤに合わせる）
    wheelR: 0.54, // 見た目タイヤ半径（= WHEEL_RADIUS * 0.9）
    stripeX: 0.22, // 白2本ストライプの中心オフセット（スクープの左右に触れる）
    stripeW: 0.18, // ストライプ幅
    wingHalfX: 0.78, // ウイング幅（キャビン幅相当の大型）
    wing0: [-1.3, 0.54] as [number, number], // 側板の下側付け根（ハッチ肩）
    wing1: [-0.86, 1.14] as [number, number], // 上前（ルーフ後端の高さから）
    wing2: [-1.58, 1.38] as [number, number], // 上後（ルーフより上へ跳ね上がった頂点）
  };

  /** レッドライオン：角ばった赤いラリー風の車体（箱形・白ストライプ・大径タイヤ）。 */
  private static buildLion(bodyColor: number, accentColor: number): THREE.Group {
    const P = AssetGenerator.LION;
    const { group, mats, rbox, box, disc } = AssetGenerator.kit(bodyColor, accentColor);
    // 面を残すためのフラット両面マテリアル（押し出しボディ／三角ウイング用）
    const red = new THREE.MeshLambertMaterial({ color: bodyColor, flatShading: true, side: THREE.DoubleSide });
    const glassBlack = new THREE.MeshLambertMaterial({ color: 0x11141c, flatShading: true, side: THREE.DoubleSide });
    const black = new THREE.MeshLambertMaterial({ color: 0x202024, flatShading: true, side: THREE.DoubleSide });
    const slot = AssetGenerator.lambert(0x0c0c0f, false); // グリル/凹みの暗がり
    const lens = AssetGenerator.lambert(0xa9c9e8, false); // 丸目の薄青レンズ
    const amber = mats.signal;
    const ext = AssetGenerator.extruder(group);
    const hw = P.halfW;

    // ── 下半身：直立ノーズ〜緩い後上がりボンネット〜水平ベルトライン〜垂直ハッチ（箱形）──
    const lower: Array<[number, number]> = [
      [P.noseZ - 0.2, P.floor],
      [P.noseZ - 0.04, -0.52],
      [P.noseZ, -0.06], // ほぼ垂直の前面
      [P.noseZ - 0.04, P.hoodY], // ボンネット前端
      [P.cowlZ, P.belt], // ボンネットはカウルへ緩く上がる
      [P.rglassZ, P.belt + 0.04], // ベルトラインは水平のままリアへ
      [P.hatchTopZ, P.belt + 0.02], // ハッチ肩の小さなデッキ
      [P.tailZ, -0.06], // ほぼ垂直のハッチ面
      [P.tailZ + 0.04, -0.52],
      [P.tailZ + 0.18, P.floor],
    ];
    ext(lower, hw, red);

    // ── キャビン（直立したガラスハウス：中ラケの前ガラス＋立ち気味の後ガラス）──
    const cabin: Array<[number, number]> = [
      [P.cowlZ, P.belt],
      [P.wsTopZ, P.roofY],
      [P.roofRearZ, P.roofY + 0.02],
      [P.rglassZ, P.belt + 0.04],
    ];
    ext(cabin, P.cabinW, glassBlack);

    // 平らな赤い屋根
    const roofZ = (P.wsTopZ + P.roofRearZ) / 2;
    const roofLen = P.wsTopZ - P.roofRearZ + 0.18;
    box(P.cabinW * 2 + 0.06, 0.12, roofLen, 0, P.roofY + 0.05, roofZ, mats.body);

    // 前後ガラスのラケ角・中点・長さ（ピラー/ワイパー共用）
    const wsMidZ = (P.cowlZ + P.wsTopZ) / 2, wsMidY = (P.belt + P.roofY) / 2;
    const wsRake = Math.atan2(P.wsTopZ - P.cowlZ, P.roofY - P.belt);
    const wsLen = Math.hypot(P.cowlZ - P.wsTopZ, P.roofY - P.belt);
    const rgMidZ = (P.roofRearZ + P.rglassZ) / 2, rgMidY = (P.roofY + P.belt) / 2;
    const rgRake = Math.atan2(P.roofRearZ - P.rglassZ, P.roofY - P.belt);
    const rgLen = Math.hypot(P.roofRearZ - P.rglassZ, P.roofY - P.belt);

    // 赤いピラー（A：前傾／B：ドア窓とクォーター窓の間／C：後傾）＝窓を分割
    for (const sx of [-(P.cabinW + 0.01), P.cabinW + 0.01]) {
      const a = box(0.1, wsLen + 0.1, 0.13, sx, wsMidY, wsMidZ, mats.body);
      a.rotation.x = wsRake;
      box(0.1, P.roofY - P.belt, 0.12, sx, wsMidY, -0.42, mats.body);
      const c = box(0.1, rgLen + 0.08, 0.14, sx, rgMidY, rgMidZ, mats.body);
      c.rotation.x = rgRake;
    }
    // ベルトライン（窓の下の赤い帯・両サイド）
    for (const sx of [-P.cabinW, P.cabinW]) box(0.06, 0.12, P.cowlZ - P.rglassZ + 0.08, sx, P.belt + 0.04, (P.cowlZ + P.rglassZ) / 2, mats.body);

    // ── 角ばった赤フェンダーフレア（平天面＋前後の斜め）＋黒アーチライナー＋黒ロッカー ──
    const tireTop = P.wheelCY + P.wheelR;
    const flare = (sz: number): void => {
      for (const s of [-1, 1]) {
        box(0.36, 0.16, 0.92, s * 1.0, tireTop + 0.1, sz, red); // 平らな天面
        const f = box(0.36, 0.16, 0.5, s * 1.0, tireTop - 0.1, sz + 0.52, red); f.rotation.x = 0.85; // 前の斜め
        const r = box(0.36, 0.16, 0.5, s * 1.0, tireTop - 0.1, sz - 0.52, red); r.rotation.x = -0.85; // 後ろの斜め
        const ring = new THREE.Mesh(new THREE.TorusGeometry(P.wheelR + 0.04, 0.07, 6, 20), black);
        ring.rotation.y = Math.PI / 2;
        ring.position.set(s * 1.05, P.wheelCY, sz);
        group.add(ring);
      }
    };
    flare(CAR.WHEEL_Z);
    flare(-CAR.WHEEL_Z);
    for (const s of [-1, 1]) box(0.16, 0.3, 0.78, s * 0.93, -0.72, 0, black); // 黒ロッカー

    // ボンネット面の傾き（スクープ/ストライプ/ウインカーを面に沿わせる）
    const hoodAng = Math.atan2(P.belt - P.hoodY, P.noseZ - 0.04 - P.cowlZ);

    // ── ボンネットスクープ（中央の赤い隆起＋前向きの黒い開口）──
    const sc = box(0.42, 0.15, 0.5, 0, 0.45, 1.06, mats.body); sc.rotation.x = hoodAng;
    box(0.3, 0.09, 0.08, 0, 0.43, 1.3, slot); // 前面にフラッシュな開口

    // ── 白い2本ストライプ（ボンネット→屋根→ハッチ。ガラス上は通さない）──
    const hoodMidZ = (P.noseZ - 0.04 + P.cowlZ) / 2;
    const hoodLen = P.noseZ - 0.04 - P.cowlZ;
    for (const sx of [-P.stripeX, P.stripeX]) {
      const h = box(P.stripeW, 0.025, hoodLen + 0.04, sx, (P.hoodY + P.belt) / 2 + 0.025, hoodMidZ, mats.accent);
      h.rotation.x = hoodAng;
      box(P.stripeW, 0.025, roofLen - 0.04, sx, P.roofY + 0.122, roofZ, mats.accent);
      const t = box(P.stripeW, 0.36, 0.03, sx, 0.3, P.tailZ - 0.005, mats.accent); t.rotation.x = 0.11;
    }

    // ── フロント：丸目2灯（クロムリング＋薄青レンズ＋十字）＋黒スリットグリル＋琥珀フォグ ──
    for (const s of [-1, 1]) {
      const x = s * 0.64;
      disc(0.21, 0.07, x, 0.04, P.noseZ - 0.05, mats.chrome); // クロムリング
      disc(0.16, 0.1, x, 0.04, P.noseZ - 0.04, lens); // 薄青レンズ
      box(0.31, 0.025, 0.02, x, 0.04, P.noseZ + 0.02, mats.chrome); // レンズ十字（横）
      box(0.025, 0.31, 0.02, x, 0.04, P.noseZ + 0.02, mats.chrome); // レンズ十字（縦）
    }
    rbox(0.84, 0.42, 0.12, 0.05, 0, -0.02, P.noseZ - 0.06, mats.grille); // グリル枠（丸角）
    for (let i = 0; i < 3; i++) box(0.7, 0.07, 0.1, 0, -0.13 + i * 0.11, P.noseZ - 0.04, slot); // 横スリット
    for (const s of [-1, 1]) { // 琥珀の角形フォグ（ピラミッド面）
      rbox(0.2, 0.19, 0.1, 0.02, s * 0.64, -0.42, P.noseZ - 0.03, amber);
      box(0.1, 0.09, 0.05, s * 0.64, -0.42, P.noseZ + 0.03, AssetGenerator.lambert(0xffcf66, false));
    }
    for (const s of [-1, 1]) { // ボンネット前端角のオレンジウインカー
      const ind = box(0.22, 0.05, 0.14, s * 0.68, P.hoodY + 0.05, P.noseZ - 0.14, AssetGenerator.lambert(0xe8641e, false));
      ind.rotation.x = hoodAng;
    }
    box(2.04, 0.3, 0.46, 0, -0.68, P.noseZ - 0.12, black); // 黒バンパー（前へ張り出す）
    box(1.6, 0.14, 0.4, 0, -0.85, P.noseZ - 0.14, black); // 下段リップ

    // ── サイド：ドアミラー／ドアのカットライン＋ハンドル／ワイパー ──
    for (const s of [-1, 1]) {
      box(0.1, 0.05, 0.05, s * (P.cabinW + 0.05), 0.64, 0.44, black); // ミラーステー
      box(0.09, 0.16, 0.11, s * (P.cabinW + 0.14), 0.66, 0.44, black); // ミラー
      box(0.02, 0.52, 0.02, s * (hw + 0.005), 0.14, 0.46, mats.grille); // ドア前端
      box(0.02, 0.52, 0.02, s * (hw + 0.005), 0.14, -0.5, mats.grille); // ドア後端
      box(0.12, 0.04, 0.05, s * (hw + 0.02), 0.34, -0.3, black); // ドアハンドル
    }
    for (const sx of [-0.38, 0.1]) { const wp = box(0.035, 0.4, 0.03, sx, 0.63, 0.49, black); wp.rotation.x = wsRake; } // ガラス面に沿うワイパー

    // ── リア：黒枠の赤＋琥珀コーナーテール＋暗い凹みプレート＋黒バンパー ──
    for (const s of [-1, 1]) {
      box(0.56, 0.28, 0.06, s * 0.62, 0.3, P.tailZ - 0.02, black); // 黒い枠
      box(0.3, 0.2, 0.06, s * 0.72, 0.3, P.tailZ - 0.05, mats.tail); // 赤（外側）
      box(0.18, 0.2, 0.06, s * 0.46, 0.3, P.tailZ - 0.05, amber); // 琥珀（内側）
    }
    box(0.94, 0.4, 0.05, 0, -0.1, P.tailZ - 0.02, slot); // プレートの暗い凹み
    AssetGenerator.addPlate(group, P.tailZ - 0.03);
    box(2.04, 0.3, 0.46, 0, -0.68, P.tailZ + 0.1, black); // 黒バンパー（後ろへ張り出す）
    box(1.6, 0.14, 0.4, 0, -0.85, P.tailZ + 0.12, black); // 下段リップ

    // ── 中空三角の大型リアウイング（ルーフ後端→跳ね上がるブレード）──
    AssetGenerator.addTriWing(group, red, P.wingHalfX, P.wing0, P.wing1, P.wing2);

    return group;
  }

  /** 三角リアスポイラー：三角フレーム側板2枚＋薄い水平ブレード。3頂点(z,y)と幅を受け取る。 */
  private static addTriWing(
    group: THREE.Group, bodyMat: THREE.Material, halfX: number,
    p0: [number, number], p1: [number, number], p2: [number, number]
  ): void {
    const outer = [p0, p1, p2];
    const cx = (p0[0] + p1[0] + p2[0]) / 3;
    const cy = (p0[1] + p1[1] + p2[1]) / 3;
    const k = 0.4;
    const inner = outer.map(
      ([z, y]) => [cx + (z - cx) * (1 - k), cy + (y - cy) * (1 - k)] as [number, number]
    );
    const shape = new THREE.Shape();
    shape.moveTo(outer[0][0], outer[0][1]);
    shape.lineTo(outer[1][0], outer[1][1]);
    shape.lineTo(outer[2][0], outer[2][1]);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(inner[0][0], inner[0][1]);
    hole.lineTo(inner[2][0], inner[2][1]);
    hole.lineTo(inner[1][0], inner[1][1]);
    hole.closePath();
    shape.holes.push(hole);

    const depth = 0.13;
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.rotateY(-Math.PI / 2);
    geo.translate(depth / 2, 0, 0);
    for (const sx of [-halfX, halfX]) {
      const plate = new THREE.Mesh(geo, bodyMat);
      plate.position.x = sx;
      group.add(plate);
    }
    const dz = outer[2][0] - outer[1][0];
    const dy = outer[2][1] - outer[1][1];
    const blade = new THREE.Mesh(new THREE.BoxGeometry(halfX * 2 + 0.16, 0.14, 0.46), bodyMat);
    blade.position.set(0, (outer[1][1] + outer[2][1]) / 2 + 0.06, (outer[1][0] + outer[2][0]) / 2 - 0.08);
    blade.rotation.x = Math.atan2(dy, -dz);
    group.add(blade);
  }

  /**
   * ホワイトホーク（hawk）のプロポーション。スポーティなクーペ風＝大きなガラスハウス・短いボンネット・角形ワイドヘッドライト＋黒グリル＋赤バッジ・
   * 黒メッシュ大開口のボディ色バンパー・ボンネットバルジ（前端スリット）・
   * トランク上の大型GTウイング（ガンメタ天面）・丸目4灯テール・ブロンズホイール。
   * **リファインはここだけ触れば形が変わる**。
   */
  static HAWK = {
    halfW: 1.0, // 車体半幅（ワイド）
    cabinW: 0.88, // キャビン半幅
    floor: -0.86, // 車体フロア
    belt: 0.38, // ベルトライン（窓下）＝大きな窓
    noseZ: 1.5, // ノーズ最前
    hoodY: 0.26, // ボンネット前端の高さ
    cowlZ: 0.62, // カウル（フロントガラス根本Z）＝短いボンネット
    wsTopZ: 0.02, // フロントガラス上端Z（大きく寝たガラス）
    roofY: 1.0, // ルーフ（ガラス上端Y）＝背の高いキャビン
    roofRearZ: -0.6, // ルーフ後端Z
    rglassZ: -1.14, // リアガラス下端Z（トランク前）
    tailZ: -1.5, // リア最後端Z
    wheelCY: -0.497, // 見た目タイヤ中心Y（0.9スケール）
    wheelR: 0.54, // 見た目タイヤ半径（= WHEEL_RADIUS * 0.9）
    wingY: 0.94, // ウイングブレード高さ
    wingHalfX: 0.94, // ウイング半幅
  };

  /** ホワイトホーク：スポーティなクーペ風。白ボディ・大キャビン・大型リアウイング・ブロンズホイール。 */
  private static buildHawk(bodyColor: number, accentColor: number): THREE.Group {
    const H = AssetGenerator.HAWK;
    const { group, mats, rbox, box, disc } = AssetGenerator.kit(bodyColor, accentColor);
    void accentColor;
    const white = new THREE.MeshLambertMaterial({ color: bodyColor, flatShading: true, side: THREE.DoubleSide });
    const glassBlack = new THREE.MeshLambertMaterial({ color: 0x11141c, flatShading: true, side: THREE.DoubleSide });
    const dark = mats.grille;
    const mesh = AssetGenerator.lambert(0x0c0c0f, false); // メッシュ開口の暗がり
    const gunmetal = AssetGenerator.lambert(0x777b82, false); // ウイング天面のガンメタ
    const ext = AssetGenerator.extruder(group);
    const hw = H.halfW;

    // ── 下半身：短いボンネット〜水平ベルトライン〜短いトランクデッキ（ノッチバック）──
    const lower: Array<[number, number]> = [
      [H.noseZ - 0.18, H.floor],
      [H.noseZ - 0.02, -0.54],
      [H.noseZ, -0.1], // 前面（上端をやや後傾）
      [H.noseZ - 0.08, H.hoodY], // ヘッドライトの乗る前端
      [H.cowlZ, H.belt], // 短いボンネット
      [H.rglassZ, H.belt + 0.04], // ベルトラインは水平のままリアへ
      [H.tailZ + 0.04, H.belt + 0.02], // 短いトランクデッキ
      [H.tailZ, -0.04], // 垂直のテール面
      [H.tailZ + 0.02, -0.54],
      [H.tailZ + 0.16, H.floor],
    ];
    ext(lower, hw, white);

    // ── キャビン（大きく寝たフロントガラス＋背の高いガラスハウス）──
    const cabin: Array<[number, number]> = [
      [H.cowlZ, H.belt],
      [H.wsTopZ, H.roofY],
      [H.roofRearZ, H.roofY + 0.02],
      [H.rglassZ, H.belt + 0.04],
    ];
    ext(cabin, H.cabinW, glassBlack);

    // 平らなボディ色ルーフ
    const roofZ = (H.wsTopZ + H.roofRearZ) / 2;
    const roofLen = H.wsTopZ - H.roofRearZ + 0.16;
    box(H.cabinW * 2 + 0.06, 0.12, roofLen, 0, H.roofY + 0.05, roofZ, mats.body);

    // 前後ガラスのラケ角・ピラー（A／B／C）＋ベルトライン帯
    const wsMidZ = (H.cowlZ + H.wsTopZ) / 2, wsMidY = (H.belt + H.roofY) / 2;
    const wsRake = Math.atan2(H.wsTopZ - H.cowlZ, H.roofY - H.belt);
    const wsLen = Math.hypot(H.cowlZ - H.wsTopZ, H.roofY - H.belt);
    const rgMidZ = (H.roofRearZ + H.rglassZ) / 2, rgMidY = (H.roofY + H.belt) / 2;
    const rgRake = Math.atan2(H.roofRearZ - H.rglassZ, H.roofY - H.belt);
    const rgLen = Math.hypot(H.roofRearZ - H.rglassZ, H.roofY - H.belt);
    for (const sx of [-(H.cabinW + 0.01), H.cabinW + 0.01]) {
      const a = box(0.1, wsLen + 0.1, 0.13, sx, wsMidY, wsMidZ, mats.body); a.rotation.x = wsRake;
      box(0.1, H.roofY - H.belt, 0.12, sx, wsMidY, -0.4, mats.body); // Bピラー
      const c = box(0.1, rgLen + 0.08, 0.14, sx, rgMidY, rgMidZ, mats.body); c.rotation.x = rgRake;
    }
    for (const sx of [-H.cabinW, H.cabinW]) box(0.06, 0.12, H.cowlZ - H.rglassZ + 0.08, sx, H.belt + 0.04, (H.cowlZ + H.rglassZ) / 2, mats.body);

    // ── フェンダー（上寄りの浅いボディ色アーチ＝リングに見せない）＋ボディ色ロッカー ──
    AssetGenerator.addLowFenders(group, mats.body, dark, H.wheelCY, H.wheelR, hw, "haunch", Math.PI * 0.72, Math.PI * 0.14);

    // ボンネット面の傾き（バルジ/スリットを面に沿わせる）
    const hoodAng = Math.atan2(H.belt - H.hoodY, H.noseZ - 0.08 - H.cowlZ);

    // ── ボンネットバルジ（幅広い隆起＋前端の黒スリット）──
    const bulge = box(0.72, 0.07, 0.55, 0, 0.36, 1.02, mats.body); bulge.rotation.x = hoodAng;
    box(0.5, 0.035, 0.06, 0, 0.34, 1.29, dark);

    // ── フロント：角形ワイドヘッドライト（暗いベゼル付き）＋黒グリル＋赤いバッジ＋メッシュ開口バンパー ──
    for (const s of [-1, 1]) {
      const bz = box(0.54, 0.18, 0.08, s * 0.63, 0.16, H.noseZ - 0.1, dark); // 暗いベゼル（白ボディとの縁取り）
      bz.rotation.z = s * -0.06;
      const hl = box(0.48, 0.14, 0.1, s * 0.63, 0.16, H.noseZ - 0.08, AssetGenerator.lambert(0xb9c2cc, false)); // 角形ライト（青みシルバー）
      hl.rotation.z = s * -0.06; // 内側へわずかに下がる台形風
      box(0.2, 0.09, 0.05, s * 0.51, 0.14, H.noseZ - 0.03, mats.head); // 内側のロービーム
    }
    box(0.56, 0.13, 0.1, 0, 0.13, H.noseZ - 0.06, dark); // ライト間の黒グリル
    box(0.1, 0.08, 0.05, 0, 0.13, H.noseZ, AssetGenerator.lambert(0xc22222, false)); // 赤いバッジ
    box(2.02, 0.36, 0.46, 0, -0.6, H.noseZ - 0.12, mats.body); // ボディ色の厚いバンパー
    box(0.9, 0.26, 0.14, 0, -0.5, H.noseZ + 0.08, mesh); // 中央の大きなメッシュ開口
    for (const s of [-1, 1]) box(0.3, 0.08, 0.08, s * 0.68, -0.46, H.noseZ + 0.11, dark); // バンパー両脇のスリット
    box(1.7, 0.1, 0.4, 0, -0.84, H.noseZ - 0.06, dark); // 黒いチンリップ（バンパー下端から前へ）

    // ── サイド：ドアミラー／ドアのカットライン＋ハンドル／ワイパー ──
    for (const s of [-1, 1]) {
      box(0.1, 0.05, 0.05, s * (H.cabinW + 0.05), 0.6, 0.48, mats.body); // ミラーステー
      box(0.09, 0.15, 0.11, s * (H.cabinW + 0.14), 0.62, 0.48, mats.body); // ミラー（ボディ色）
      box(0.02, 0.5, 0.02, s * (hw + 0.005), 0.1, 0.5, dark); // ドア前端
      box(0.02, 0.5, 0.02, s * (hw + 0.005), 0.1, -0.44, dark); // ドア後端
      box(0.12, 0.04, 0.05, s * (hw + 0.02), 0.28, -0.24, dark); // ドアハンドル
    }
    for (const sx of [-0.4, 0.08]) { const wp = box(0.035, 0.4, 0.03, sx, 0.56, 0.52, dark); wp.rotation.x = wsRake; }

    // ── リア：黒パネルの丸目4灯テール＋プレート＋ボディ色バンパー＋ディフューザー ──
    box(1.5, 0.32, 0.08, 0, 0.2, H.tailZ - 0.01, AssetGenerator.lambert(0x1b1b20, false)); // 黒テールパネル
    for (const sx of [-0.56, -0.28, 0.28, 0.56]) disc(0.11, 0.1, sx, 0.2, H.tailZ - 0.04, mats.tail); // 丸目4灯
    box(0.94, 0.34, 0.05, 0, -0.14, H.tailZ - 0.01, mesh); // プレートの暗い凹み
    AssetGenerator.addPlate(group, H.tailZ - 0.03);
    box(2.02, 0.36, 0.46, 0, -0.6, H.tailZ + 0.1, mats.body); // ボディ色の厚いバンパー
    box(1.2, 0.1, 0.3, 0, -0.82, H.tailZ + 0.12, dark); // 黒ディフューザー
    { // 大径シングルマフラー（左）
      const muf = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.2, 10).rotateX(Math.PI / 2), mats.chrome);
      muf.position.set(-0.55, -0.74, H.tailZ - 0.14); // バンパー面から少し覗く
      group.add(muf);
    }

    // ── GTウイング（ボディ色スタンション＋ガンメタ天面のブレード＋小さな端板）──
    for (const s of [-1, 1]) {
      const st = box(0.1, 0.52, 0.28, s * 0.6, 0.68, -1.32, mats.body);
      st.rotation.x = -0.15; // やや後傾
    }
    const blade = rbox(H.wingHalfX * 2, 0.09, 0.46, 0.03, 0, H.wingY, -1.4, mats.body);
    blade.rotation.x = 0.1; // 前端をわずかに下げる
    const bladeTop = box(H.wingHalfX * 2 - 0.1, 0.03, 0.34, 0, H.wingY + 0.055, -1.4, gunmetal);
    bladeTop.rotation.x = 0.1;
    for (const s of [-1, 1]) box(0.05, 0.16, 0.4, s * (H.wingHalfX - 0.02), H.wingY + 0.02, -1.4, mats.body); // 端板

    return group;
  }

  /** 側面プロフィール(z,y)を X 方向へ押し出すメッシュを作って group に足すヘルパー（各車共用）。 */
  private static extruder(group: THREE.Group) {
    return (pts: Array<[number, number]>, halfW: number, mat: THREE.Material): THREE.Mesh => {
      const shape = new THREE.Shape();
      shape.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
      shape.closePath();
      const depth = halfW * 2;
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      geo.rotateY(-Math.PI / 2);
      geo.translate(depth / 2, 0, 0);
      const m = new THREE.Mesh(geo, mat);
      group.add(m);
      return m;
    };
  }

  /**
   * 見た目小径タイヤ用の低いフェンダー（各車共用）：タイヤ上端を覆うボディ色アーチ＋黒いライナーリング。
   * wheelCY/wheelR は見た目タイヤの中心Y・半径。bodyColorHex はボディ色マテリアル。
   */
  private static addLowFenders(
    group: THREE.Group, bodyMat: THREE.Material, blackMat: THREE.Material,
    wheelCY: number, wheelR: number, halfW: number,
    style: "pillow" | "shelf" | "haunch" = "haunch",
    // haunch アーチの弧長と回転（省略時は従来値＝hawk/wyvern はそのまま）。
    // 弧を短く上寄せするとアーチ下部が開き、タイヤ下側がのぞく（whale で使用）。
    haunchArc: number = Math.PI * 1.4, haunchRotZ: number = -0.62,
    // false でロッカーを追加しない（piranha＝底面をバンパー高さで切り上げる車用）
    withRocker: boolean = true
  ): void {
    const fScale = wheelR / 0.6;
    const tireTop = wheelCY + wheelR;
    const rbg = (w: number, h: number, d: number, r: number, x: number, y: number, z: number): THREE.Mesh => {
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), bodyMat);
      m.position.set(x, y, z);
      group.add(m);
      return m;
    };
    const ringAt = (rr: number, tube: number, x: number, z: number): void => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rr, tube, 6, 18), blackMat);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(x, wheelCY, z);
      group.add(ring);
    };
    for (const sz of [CAR.WHEEL_Z, -CAR.WHEEL_Z]) {
      for (const s of [-1, 1]) {
        if (style === "pillow") {
          const len = (sz < 0 ? 1.44 : 1.34) * fScale;
          const brow = rbg(0.4, 0.36, len, 0.12, s * (halfW - 0.06), tireTop - 0.04, sz); brow.rotation.z = s * -0.18;
          rbg(0.28, 0.5 * fScale, 0.34, 0.1, s * (halfW - 0.05), wheelCY + 0.24 * fScale, sz + len * 0.4);
          rbg(0.28, 0.5 * fScale, 0.34, 0.1, s * (halfW - 0.05), wheelCY + 0.24 * fScale, sz - len * 0.4);
          ringAt(wheelR + 0.05, 0.08, s * (halfW - 0.05), sz);
        } else if (style === "shelf") {
          const len = (sz < 0 ? 1.46 : 1.36) * fScale;
          const brow = rbg(0.26, 0.24, len, 0.06, s * (halfW + 0.02), tireTop, sz); brow.rotation.z = s * -0.1;
          rbg(0.22, 0.44 * fScale, 0.28, 0.06, s * (halfW + 0.03), wheelCY + 0.22 * fScale, sz + len * 0.4);
          rbg(0.22, 0.44 * fScale, 0.28, 0.06, s * (halfW + 0.03), wheelCY + 0.22 * fScale, sz - len * 0.4);
          ringAt(wheelR + 0.04, 0.07, s * (halfW + 0.03), sz);
        } else {
          // 被せる滑らかなフェンダーアーチ（部分トーラス）＝タイヤを覆い、横へはみ出させない。
          const flareGeo = new THREE.TorusGeometry(wheelR + 0.06, 0.1, 8, 22, haunchArc);
          flareGeo.rotateZ(haunchRotZ); // 開口(gap)を下(-Y)へ
          const fl = new THREE.Mesh(flareGeo, bodyMat);
          fl.rotation.y = Math.PI / 2; // 車輪面(YZ)へ
          fl.position.set(s * 1.02, wheelCY, sz);
          group.add(fl);
        }
      }
    }
    // 低いロッカー（ボディ色＝下部を黒くしない）
    if (withRocker) {
      for (const s of [-1, 1]) {
        const rk = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 1.0), bodyMat);
        rk.position.set(s * (halfW - 0.02), wheelCY - wheelR + 0.28, -0.1);
        group.add(rk);
      }
    }
  }

  /**
   * ブルーホエール（whale）のプロポーション。ウェッジ系スポーツカー風＝低いウェッジノーズ＋**格納リトラのフタ（シーム付き）**＋大きく寝たフロント
   * ガラス／大きなガラスハウス＋リフトバック＋**デッキ縁のリップスポイラー**＋
   * **フロントの横一文字赤ストリップ**＋黒バンパー。**リファインはここだけ触れば形が変わる**。
   */
  static WHALE = {
    halfW: 0.98, // 車体半幅
    cabinW: 0.86, // キャビン半幅
    floor: -0.86, // 車体フロア
    belt: 0.36, // ベルトライン（窓下）
    noseZ: 1.52, // ノーズ最前
    noseTopY: 0.1, // ノーズ先端の高さ（低いウェッジ）
    cowlZ: 0.62, // カウル（フロントガラス根本Z）
    wsTopZ: 0.0, // フロントガラス上端Z（大きく寝たガラス）
    roofY: 0.98, // ルーフ（ガラス上端Y）＝背の高いキャビン
    roofRearZ: -0.55, // ルーフ後端Z
    rglassZ: -1.1, // リアガラス下端Z（リフトバック）
    deckY: 0.42, // リアデッキ天面Y
    tailZ: -1.48, // リア最後端Z
    wheelCY: -0.497, // 見た目タイヤ中心Y（0.9スケール）
    wheelR: 0.54, // 見た目タイヤ半径（= WHEEL_RADIUS * 0.9）
  };

  /** ブルーホエール：ウェッジ系スポーツカー風。青ボディ・リトラのフタ・赤ストリップ・リップスポイラー。 */
  private static buildWhale(bodyColor: number, accentColor: number): THREE.Group {
    const W = AssetGenerator.WHALE;
    const { group, mats, box } = AssetGenerator.kit(bodyColor, accentColor);
    void accentColor;
    const blue = new THREE.MeshLambertMaterial({ color: bodyColor, flatShading: true, side: THREE.DoubleSide });
    const glassBlack = new THREE.MeshLambertMaterial({ color: 0x0e1118, flatShading: true, side: THREE.DoubleSide });
    const dark = mats.grille;
    const slot = AssetGenerator.lambert(0x0c0c0f, false); // 開口/凹みの暗がり
    const ext = AssetGenerator.extruder(group);
    const hw = W.halfW;

    // ── 下半身：低いウェッジノーズ〜緩いボンネット〜水平ベルトライン〜短い高めデッキ ──
    const lower: Array<[number, number]> = [
      [W.noseZ - 0.16, W.floor],
      [W.noseZ - 0.02, -0.52],
      [W.noseZ, -0.12], // ほぼ垂直の前面
      [W.noseZ - 0.02, W.noseTopY], // 低いウェッジの先端
      [W.cowlZ, W.belt], // リトラのフタが乗るボンネット斜面
      [W.rglassZ, W.deckY], // ベルトラインはわずかに上がってリアへ
      [W.tailZ + 0.04, W.deckY], // 短いリアデッキ
      [W.tailZ, -0.02], // ほぼ垂直のテール面
      [W.tailZ + 0.02, -0.52],
      [W.tailZ + 0.16, W.floor],
    ];
    ext(lower, hw, blue);

    // ── キャビン（大きく寝たフロントガラス＋大きなガラスハウス＋リフトバック）──
    const cabin: Array<[number, number]> = [
      [W.cowlZ, W.belt],
      [W.wsTopZ, W.roofY],
      [W.roofRearZ, W.roofY + 0.02],
      [W.rglassZ, W.deckY],
    ];
    ext(cabin, W.cabinW, glassBlack);

    // 平らなボディ色ルーフ
    const roofZ = (W.wsTopZ + W.roofRearZ) / 2;
    const roofLen = W.wsTopZ - W.roofRearZ + 0.16;
    box(W.cabinW * 2 + 0.06, 0.12, roofLen, 0, W.roofY + 0.05, roofZ, mats.body);

    // 前後ガラスのラケ角・ピラー（A／B／C）＋ベルトライン帯
    const wsMidZ = (W.cowlZ + W.wsTopZ) / 2, wsMidY = (W.belt + W.roofY) / 2;
    const wsRake = Math.atan2(W.wsTopZ - W.cowlZ, W.roofY - W.belt);
    const wsLen = Math.hypot(W.cowlZ - W.wsTopZ, W.roofY - W.belt);
    const rgMidZ = (W.roofRearZ + W.rglassZ) / 2, rgMidY = (W.roofY + W.deckY) / 2;
    const rgRake = Math.atan2(W.roofRearZ - W.rglassZ, W.roofY - W.deckY);
    const rgLen = Math.hypot(W.roofRearZ - W.rglassZ, W.roofY - W.deckY);
    for (const sx of [-(W.cabinW + 0.01), W.cabinW + 0.01]) {
      const a = box(0.1, wsLen + 0.1, 0.13, sx, wsMidY, wsMidZ, mats.body); a.rotation.x = wsRake;
      box(0.1, W.roofY - W.belt, 0.12, sx, wsMidY, -0.38, mats.body); // Bピラー
      const c = box(0.1, rgLen + 0.08, 0.14, sx, rgMidY, rgMidZ, mats.body); c.rotation.x = rgRake;
    }
    for (const sx of [-W.cabinW, W.cabinW]) box(0.06, 0.12, W.cowlZ - W.rglassZ + 0.08, sx, W.belt + 0.05, (W.cowlZ + W.rglassZ) / 2, mats.body);

    // ── フェンダー（上寄りの浅いボディ色アーチ）＋ボディ色ロッカー ──
    AssetGenerator.addLowFenders(group, mats.body, dark, W.wheelCY, W.wheelR, hw, "haunch", Math.PI * 0.72, Math.PI * 0.14);

    // ボンネット面の傾きと表面高さ（リトラのフタ/シームを面に沿わせる）
    const hoodAng = Math.atan2(W.belt - W.noseTopY, W.noseZ - 0.02 - W.cowlZ);
    const hoodYAt = (z: number): number =>
      W.noseTopY + ((W.noseZ - 0.02 - z) / (W.noseZ - 0.02 - W.cowlZ)) * (W.belt - W.noseTopY);

    // ── 格納リトラクタブル灯のフタ（ボンネット前端の左右・下の暗い縁取りでフタの輪郭を出す）──
    for (const s of [-1, 1]) {
      const rim = box(0.54, 0.04, 0.5, s * 0.52, hoodYAt(1.26) + 0.012, 1.26, dark); rim.rotation.x = hoodAng; // 縁取り
      const lid = box(0.5, 0.045, 0.46, s * 0.52, hoodYAt(1.26) + 0.028, 1.26, mats.body); lid.rotation.x = hoodAng;
    }
    // ボンネットの薄いパネルシーム（左右）
    for (const s of [-1, 1]) { const sm = box(0.02, 0.015, 0.56, s * 0.62, hoodYAt(0.92) + 0.012, 0.92, dark); sm.rotation.x = hoodAng; }

    // ── フロント：横一文字の赤ストリップ＋小さな赤エンブレム（ノーズ先端に載せる）＋黒バンパー＋下段スロット ──
    box(1.72, 0.07, 0.05, 0, -0.03, W.noseZ + 0.01, mats.tail); // 赤ストリップ（全幅）
    { const em = box(0.1, 0.02, 0.09, 0, hoodYAt(1.42) + 0.014, 1.42, AssetGenerator.lambert(0xb01a1a, false)); em.rotation.x = hoodAng; } // 赤エンブレム
    box(2.0, 0.3, 0.44, 0, -0.36, W.noseZ - 0.1, dark); // 黒バンパー（前へ張り出す）
    box(0.6, 0.16, 0.06, 0, -0.36, W.noseZ + 0.13, slot); // バンパーの黒いプレート台
    box(0.9, 0.08, 0.08, 0, -0.66, W.noseZ - 0.02, slot); // 下段の吸気スロット（ボディ色エプロン上）

    // ── サイド：ドアミラー／ドアのカットライン＋ハンドル／ワイパー ──
    for (const s of [-1, 1]) {
      box(0.1, 0.05, 0.05, s * (W.cabinW + 0.05), 0.58, 0.52, mats.body); // ミラーステー
      box(0.09, 0.15, 0.11, s * (W.cabinW + 0.14), 0.6, 0.52, mats.body); // ミラー（ボディ色）
      box(0.02, 0.5, 0.02, s * (hw + 0.005), 0.08, 0.54, dark); // ドア前端
      box(0.02, 0.5, 0.02, s * (hw + 0.005), 0.08, -0.42, dark); // ドア後端
      box(0.12, 0.04, 0.05, s * (hw + 0.02), 0.27, -0.22, dark); // ドアハンドル
    }
    for (const sx of [-0.4, 0.08]) { const wp = box(0.035, 0.4, 0.03, sx, 0.54, 0.56, dark); wp.rotation.x = wsRake; }

    // ── リアデッキ縁のリップスポイラー（低いダックテール・端で少し立ち上がる）──
    const lip = box(1.86, 0.09, 0.28, 0, W.deckY + 0.06, W.tailZ + 0.1, mats.body);
    lip.rotation.x = -0.16; // 後端を持ち上げる
    for (const s of [-1, 1]) box(0.09, 0.1, 0.3, s * 0.885, W.deckY + 0.08, W.tailZ + 0.11, mats.body); // 端の立ち上がり

    // ── リア：横一文字の赤テール（黒の水平トリム）＋暗い凹みプレート＋黒バンパー ──
    box(1.86, 0.2, 0.06, 0, 0.22, W.tailZ - 0.01, mats.tail); // 全幅の赤テール
    box(1.86, 0.03, 0.07, 0, 0.22, W.tailZ - 0.01, dark); // 水平トリム
    box(0.94, 0.36, 0.05, 0, -0.12, W.tailZ - 0.01, slot); // プレートの暗い凹み
    AssetGenerator.addPlate(group, W.tailZ - 0.02);
    box(2.0, 0.3, 0.44, 0, -0.42, W.tailZ + 0.08, dark); // 黒バンパー（後ろへ張り出す）
    box(1.2, 0.1, 0.3, 0, -0.66, W.tailZ + 0.1, slot); // 下段の黒スロット

    return group;
  }

  /**
   * イエローピラニア（piranha）のプロポーション。クラシックな小型車風＝**背高で短くずんぐり**。白い2トーンルーフ（前寄りのサンルーフ凹み）＋
   * ボンネットの白2本ストライプ、クロム横バーグリル、ボンネット肩の丸目、
   * 薄いクロムブレードバンパー（端が立ち上がる）、丸いフェンダー。
   * **リファインはここだけ触れば形が変わる**。
   */
  static PIRANHA = {
    halfW: 1.04, cabinW: 0.84, // ワイドボディ（タイヤを覆う）
    floor: -0.56, // 車体フロア＝クロムバンパー下端（-0.565）より下にボディを出さない

    belt: 0.42, // 窓下（スカットル）＝高いベルトライン
    roofY: 1.06, // ルーフ（ガラス上端Y）＝とても背が高いキャビン
    noseZ: 1.5, // ノーズ最前
    hoodY: 0.22, // ボンネット前端の高さ
    hoodMidZ: 1.14, hoodMidY: 0.35, // 丸いボンネットの中間点
    cowlZ: 0.85, // カウル（フロントガラス根本Z）＝短いボンネット
    wsTopZ: 0.45, // フロントガラス上端Z（立ち気味）
    roofRearZ: -0.52, // ルーフ後端Z
    rglassZ: -0.95, // リアガラス下端Z
    bootZ: -1.38, bootY: 0.32, // 短く下がるブート天面
    tailZ: -1.48, // リア最後端Z
    wheelCY: -0.497, wheelR: 0.54, // 見た目タイヤ（0.9スケール）
  };

  /** イエローピラニア：背高で短いクラシック小型車風。黄ボディ・白ルーフ・白ストライプ・クロムグリル/バンパー。 */
  private static buildPiranha(bodyColor: number, accentColor: number): THREE.Group {
    const P = AssetGenerator.PIRANHA;
    const { group, mats, rbox, box, disc } = AssetGenerator.kit(bodyColor, accentColor);
    const bodyD = new THREE.MeshLambertMaterial({ color: bodyColor, flatShading: true, side: THREE.DoubleSide });
    const glass = new THREE.MeshLambertMaterial({ color: 0x0e1118, flatShading: true, side: THREE.DoubleSide });
    const dark = mats.grille;
    const ext = AssetGenerator.extruder(group);
    const hw = P.halfW;

    // ── 下半身：丸い短いボンネット〜高いベルトライン〜短く丸いブート（ずんぐり）──
    //   底面はクロムバンパー下端で切り上げ＝バンパーより下にボディを出さない。
    const lower: Array<[number, number]> = [
      [P.noseZ - 0.06, P.floor],
      [P.noseZ, -0.08], // 前面
      [P.noseZ - 0.04, P.hoodY], // ボンネット前端
      [P.hoodMidZ, P.hoodMidY], // 丸いボンネット（中間点）
      [P.cowlZ, P.belt], // カウル
      [P.rglassZ, P.belt + 0.02], // ベルトラインはリアへほぼ水平
      [P.bootZ, P.bootY], // 短く下がるブート天面
      [P.tailZ, -0.06], // 丸い背面
      [P.tailZ + 0.06, P.floor],
    ];
    ext(lower, hw, bodyD);

    // ── キャビン（とても背が高い立ったガラスハウス）──
    const cabin: Array<[number, number]> = [
      [P.cowlZ, P.belt],
      [P.wsTopZ, P.roofY],
      [P.roofRearZ, P.roofY + 0.02],
      [P.rglassZ, P.belt + 0.02],
    ];
    ext(cabin, P.cabinW, glass);

    // ── 白い2トーンルーフ（丸角）＋前寄りのサンルーフ風の凹み ──
    const roofZ = (P.wsTopZ + P.roofRearZ) / 2;
    const roofLen = P.wsTopZ - P.roofRearZ + 0.16;
    rbox(P.cabinW * 2 + 0.1, 0.14, roofLen, 0.06, 0, P.roofY + 0.05, roofZ, mats.accent);
    box(0.56, 0.02, 0.44, 0, P.roofY + 0.115, roofZ + 0.14, AssetGenerator.lambert(0xd8dcdf, false)); // サンルーフ凹み

    // 窓のピラー（A：前傾／B：中央／C：後傾）＋ベルトライン帯（ボディ色＝ルーフだけ白）
    const wsMidZ = (P.cowlZ + P.wsTopZ) / 2, wsMidY = (P.belt + P.roofY) / 2;
    const wsRake = Math.atan2(P.wsTopZ - P.cowlZ, P.roofY - P.belt);
    const wsLen = Math.hypot(P.cowlZ - P.wsTopZ, P.roofY - P.belt);
    const rgMidZ = (P.roofRearZ + P.rglassZ) / 2, rgMidY = (P.roofY + P.belt) / 2;
    const rgRake = Math.atan2(P.roofRearZ - P.rglassZ, P.roofY - P.belt);
    const rgLen = Math.hypot(P.roofRearZ - P.rglassZ, P.roofY - P.belt);
    for (const sx of [-(P.cabinW + 0.01), P.cabinW + 0.01]) {
      const a = box(0.1, wsLen + 0.08, 0.13, sx, wsMidY, wsMidZ, mats.body); a.rotation.x = wsRake;
      box(0.1, P.roofY - P.belt, 0.12, sx, wsMidY, -0.18, mats.body); // Bピラー
      const c = box(0.1, rgLen + 0.08, 0.14, sx, rgMidY, rgMidZ, mats.body); c.rotation.x = rgRake;
    }
    for (const sx of [-P.cabinW, P.cabinW]) box(0.06, 0.12, P.cowlZ - P.rglassZ + 0.08, sx, P.belt + 0.04, (P.cowlZ + P.rglassZ) / 2, mats.body);
    // クロムの窓下トリム（細いモール）
    for (const sx of [-(P.cabinW + 0.02), P.cabinW + 0.02]) box(0.03, 0.03, P.cowlZ - P.rglassZ, sx, P.belt + 0.1, (P.cowlZ + P.rglassZ) / 2, mats.chrome);

    // ── フェンダー：上寄りの浅いボディ色アーチ（＝丸いフェンダーリップ）。ロッカー無し（底面を出さない）──
    AssetGenerator.addLowFenders(group, mats.body, dark, P.wheelCY, P.wheelR, hw, "haunch", Math.PI * 0.72, Math.PI * 0.14, false);

    // ── 白い2本ボンネットストライプ（丸いボンネットの2面に沿わせる）──
    const ang1 = Math.atan2(P.hoodMidY - P.hoodY, P.noseZ - 0.04 - P.hoodMidZ); // 前面側
    const ang2 = Math.atan2(P.belt - P.hoodMidY, P.hoodMidZ - P.cowlZ); // カウル側
    for (const sx of [-0.2, 0.2]) {
      const s1 = box(0.14, 0.025, Math.hypot(P.noseZ - 0.04 - P.hoodMidZ, P.hoodMidY - P.hoodY) - 0.06,
        sx, (P.hoodY + P.hoodMidY) / 2 + 0.03, (P.noseZ - 0.04 + P.hoodMidZ) / 2 - 0.03, mats.accent);
      s1.rotation.x = ang1;
      const s2 = box(0.14, 0.025, Math.hypot(P.hoodMidZ - P.cowlZ, P.belt - P.hoodMidY) + 0.02,
        sx, (P.hoodMidY + P.belt) / 2 + 0.02, (P.hoodMidZ + P.cowlZ) / 2, mats.accent);
      s2.rotation.x = ang2;
    }

    // ── フロント：クロム横バーグリル＋ボンネット肩の丸目＋琥珀ウインカー＋クロムブレードバンパー ──
    rbox(0.74, 0.36, 0.1, 0.08, 0, -0.02, P.noseZ - 0.06, mats.chrome); // グリル枠（丸角）
    box(0.6, 0.26, 0.06, 0, -0.02, P.noseZ - 0.02, dark); // 奥の暗がり
    for (let i = 0; i < 5; i++) box(0.58, 0.022, 0.08, 0, -0.13 + i * 0.055, P.noseZ, mats.chrome); // 横バー
    for (const s of [-1, 1]) { // 丸目（ボンネット肩・やや上向き）
      const ring = disc(0.13, 0.07, s * 0.56, 0.12, P.noseZ - 0.06, mats.chrome); ring.rotation.x = -0.3;
      const lens = disc(0.1, 0.09, s * 0.56, 0.13, P.noseZ - 0.04, AssetGenerator.lambert(0xd9dee3, false)); lens.rotation.x = -0.3;
    }
    for (const s of [-1, 1]) box(0.1, 0.09, 0.06, s * 0.6, -0.3, P.noseZ + 0.0, mats.signal); // 琥珀ウインカー
    rbox(1.88, 0.13, 0.34, 0.05, 0, -0.5, P.noseZ - 0.08, mats.chrome); // 薄いクロムブレードバンパー
    for (const s of [-1, 1]) { const w = rbox(0.09, 0.26, 0.24, 0.04, s * 0.93, -0.4, P.noseZ - 0.08, mats.chrome); w.rotation.z = s * -0.22; } // 端の立ち上がり

    // ── サイド：ドアのカットライン＋クロムハンドル＋給油キャップ／ワイパー ──
    for (const s of [-1, 1]) {
      box(0.02, 0.5, 0.02, s * (hw + 0.005), 0.12, 0.52, dark); // ドア前端
      box(0.02, 0.5, 0.02, s * (hw + 0.005), 0.12, -0.22, dark); // ドア後端
      box(0.1, 0.035, 0.05, s * (hw + 0.02), 0.32, 0.05, mats.chrome); // クロムハンドル
    }
    box(0.03, 0.09, 0.09, hw + 0.005, 0.26, -1.08, mats.chrome); // 給油キャップ（右リアクォーター）
    for (const sx of [-0.26, 0.14]) { const wp = box(0.03, 0.3, 0.025, sx, 0.58, 0.72, dark); wp.rotation.x = wsRake; }

    // ── リア：縦型テール（赤＋琥珀）＋暗い凹みプレート＋クロムブレードバンパー ──
    for (const s of [-1, 1]) {
      rbox(0.15, 0.3, 0.07, 0.04, s * 0.64, 0.08, P.tailZ - 0.01, mats.tail); // 赤テール（縦）
      box(0.12, 0.09, 0.06, s * 0.64, -0.12, P.tailZ - 0.01, mats.signal); // 琥珀（下段）
    }
    box(0.8, 0.32, 0.05, 0, -0.1, P.tailZ - 0.01, AssetGenerator.lambert(0x0c0c0f, false)); // プレートの暗い凹み
    AssetGenerator.addPlate(group, P.tailZ - 0.03);
    rbox(1.88, 0.13, 0.34, 0.05, 0, -0.5, P.tailZ + 0.06, mats.chrome); // 薄いクロムブレードバンパー
    for (const s of [-1, 1]) { const w = rbox(0.09, 0.26, 0.24, 0.04, s * 0.93, -0.4, P.tailZ + 0.06, mats.chrome); w.rotation.z = s * -0.22; } // 端の立ち上がり

    return group;
  }

  /**
   * ブラックワイバー（wyvern）のプロポーション。ロング＆ローのマッスルカー風＝**白2本ストライプ（ノーズ面まで回り込む）**＋中央ビークの
   * Endura ノーズ＋**スプリットの銀メッシュグリル**＋丸目、大きなキャビン＋ファストバック＋
   * ハイデッキのダックテール、**ロッカー下のクロムサイドパイプ**。
   * **リファインはここだけ触れば形が変わる**。
   */
  static WYVERN = {
    halfW: 1.0, // 車体半幅（ワイド）
    cabinW: 0.86, // キャビン半幅
    floor: -0.86, // 車体フロア
    belt: 0.34, // ベルトライン（窓下）＝低め・マッスル
    noseZ: 1.54, // ノーズ最前
    hoodY: 0.18, // ボンネット前端の高さ（低いロングノーズ）
    cowlZ: 0.55, // カウル（フロントガラス根本Z）
    wsTopZ: 0.0, // フロントガラス上端Z（ラケ）
    roofY: 0.92, // ルーフ（ガラス上端Y）
    roofRearZ: -0.45, // ルーフ後端Z
    rglassZ: -1.05, // ファストバック（リアガラス）下端Z
    deckY: 0.38, // ハイデッキ（Kammテール）天面Y
    tailZ: -1.5, // リア最後端Z
    wheelCY: -0.497, wheelR: 0.54, // 見た目タイヤ（0.9スケール）
  };

  /** ブラックワイバー：ロング＆ローのマッスルカー風。黒・白ストライプ・スプリット銀メッシュグリル・サイドパイプ。 */
  private static buildWyvern(bodyColor: number, accentColor: number): THREE.Group {
    const W = AssetGenerator.WYVERN;
    const { group, mats, rbox, box, disc } = AssetGenerator.kit(bodyColor, accentColor);
    const black = new THREE.MeshLambertMaterial({ color: bodyColor, flatShading: true, side: THREE.DoubleSide });
    const glassBlack = new THREE.MeshLambertMaterial({ color: 0x0d1017, flatShading: true, side: THREE.DoubleSide });
    const dark = mats.grille;
    const ext = AssetGenerator.extruder(group);
    const hw = W.halfW;

    // ── 下半身：低いロングノーズ〜水平ベルトライン〜ハイデッキ（Kammテール）──
    const lower: Array<[number, number]> = [
      [W.noseZ - 0.14, W.floor],
      [W.noseZ - 0.02, -0.5],
      [W.noseZ, -0.06], // ほぼ垂直の前面（Endura ノーズ）
      [W.noseZ - 0.04, W.hoodY], // ボンネット前端
      [W.cowlZ, W.belt], // 長い緩斜面のボンネット
      [W.rglassZ, W.belt + 0.04], // ベルトラインはほぼ水平にリアへ
      [W.tailZ + 0.04, W.deckY], // ハイデッキ（Kammテール）
      [W.tailZ, -0.04], // 垂直のテール面
      [W.tailZ + 0.02, -0.5],
      [W.tailZ + 0.16, W.floor],
    ];
    ext(lower, hw, black);

    // ── キャビン（ラケたフロントガラス＋丸めのルーフ＋ファストバック）──
    const cabin: Array<[number, number]> = [
      [W.cowlZ, W.belt],
      [W.wsTopZ, W.roofY],
      [W.roofRearZ, W.roofY + 0.02],
      [W.rglassZ, W.belt + 0.04],
    ];
    ext(cabin, W.cabinW, glassBlack);

    // 丸角のボディ色ルーフ
    const roofZ = (W.wsTopZ + W.roofRearZ) / 2;
    const roofLen = W.wsTopZ - W.roofRearZ + 0.16;
    rbox(W.cabinW * 2 + 0.06, 0.12, roofLen, 0.04, 0, W.roofY + 0.05, roofZ, mats.body);

    // 前後ガラスのラケ角・ピラー（A／B／C）＋ベルトライン帯
    const wsMidZ = (W.cowlZ + W.wsTopZ) / 2, wsMidY = (W.belt + W.roofY) / 2;
    const wsRake = Math.atan2(W.wsTopZ - W.cowlZ, W.roofY - W.belt);
    const wsLen = Math.hypot(W.cowlZ - W.wsTopZ, W.roofY - W.belt);
    const rgMidZ = (W.roofRearZ + W.rglassZ) / 2, rgMidY = (W.roofY + W.belt) / 2;
    const rgRake = Math.atan2(W.roofRearZ - W.rglassZ, W.roofY - W.belt);
    const rgLen = Math.hypot(W.roofRearZ - W.rglassZ, W.roofY - W.belt);
    for (const sx of [-(W.cabinW + 0.01), W.cabinW + 0.01]) {
      const a = box(0.1, wsLen + 0.1, 0.13, sx, wsMidY, wsMidZ, mats.body); a.rotation.x = wsRake;
      box(0.1, W.roofY - W.belt, 0.12, sx, wsMidY, -0.3, mats.body); // Bピラー
      const c = box(0.1, rgLen + 0.08, 0.14, sx, rgMidY, rgMidZ, mats.body); c.rotation.x = rgRake;
    }
    for (const sx of [-W.cabinW, W.cabinW]) box(0.06, 0.12, W.cowlZ - W.rglassZ + 0.08, sx, W.belt + 0.05, (W.cowlZ + W.rglassZ) / 2, mats.body);

    // ── フェンダー（上寄りの浅いボディ色アーチ）＋ボディ色ロッカー ──
    AssetGenerator.addLowFenders(group, mats.body, dark, W.wheelCY, W.wheelR, hw, "haunch", Math.PI * 0.72, Math.PI * 0.14);

    // ボンネット面の傾き（ストライプを面に沿わせる）
    const hoodAng = Math.atan2(W.belt - W.hoodY, W.noseZ - 0.04 - W.cowlZ);

    // ── 白い2本ストライプ（ボンネット→ノーズ面へ回り込む）──
    const hoodLen = W.noseZ - 0.04 - W.cowlZ;
    for (const sx of [-0.24, 0.24]) {
      const h = box(0.15, 0.025, hoodLen - 0.04, sx, (W.hoodY + W.belt) / 2 + 0.025, (W.noseZ - 0.04 + W.cowlZ) / 2 - 0.01, mats.accent);
      h.rotation.x = hoodAng;
      const n = box(0.15, 0.11, 0.025, sx, 0.125, W.noseZ + 0.008, mats.accent); // ノーズ面の続き（グリル上端まで）
      n.rotation.x = 0.16;
    }

    // ── フロント：中央ビーク＋スプリットの銀メッシュグリル＋丸目＋ボディ色バンパー ──
    box(0.15, 0.32, 0.12, 0, -0.1, W.noseZ + 0.02, mats.body); // 中央ビーク（Endura）
    for (const s of [-1, 1]) {
      const x = s * 0.38;
      rbox(0.5, 0.3, 0.08, 0.04, x, -0.1, W.noseZ - 0.04, dark); // 暗い枠
      box(0.42, 0.22, 0.06, x, -0.1, W.noseZ + 0.0, mats.chrome); // 銀メッシュ
      for (let i = 0; i < 3; i++) box(0.42, 0.018, 0.02, x, -0.17 + i * 0.07, W.noseZ + 0.032, dark); // メッシュ横線
      for (let i = 0; i < 3; i++) box(0.018, 0.22, 0.02, x + (i - 1) * 0.12, -0.1, W.noseZ + 0.032, dark); // メッシュ縦線
    }
    for (const s of [-1, 1]) { // 丸目（グリル外側）
      disc(0.11, 0.06, s * 0.8, -0.06, W.noseZ - 0.05, mats.chrome);
      disc(0.08, 0.08, s * 0.8, -0.06, W.noseZ - 0.02, AssetGenerator.lambert(0xc9cfd6, false));
    }
    box(2.0, 0.2, 0.4, 0, -0.34, W.noseZ - 0.1, mats.body); // ボディ色バンパー（Endura＝前へ張り出す）
    box(1.6, 0.12, 0.32, 0, -0.58, W.noseZ - 0.1, dark); // 暗いバランス/チン

    // ── サイド：クロムサイドパイプ／ドアのカットライン＋ハンドル／ワイパー ──
    for (const s of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.72, 10).rotateX(Math.PI / 2), mats.chrome);
      pipe.position.set(s * 1.0, -0.76, -0.02);
      group.add(pipe);
      box(0.02, 0.48, 0.02, s * (hw + 0.005), 0.08, 0.46, dark); // ドア前端
      box(0.02, 0.48, 0.02, s * (hw + 0.005), 0.08, -0.36, dark); // ドア後端
      box(0.12, 0.04, 0.05, s * (hw + 0.02), 0.25, -0.16, dark); // ドアハンドル
    }
    for (const sx of [-0.38, 0.08]) { const wp = box(0.035, 0.36, 0.03, sx, 0.52, 0.44, dark); wp.rotation.x = wsRake; }

    // ── リアデッキ縁のダックテールリップ ──
    const duck = box(1.9, 0.08, 0.26, 0, W.deckY + 0.05, W.tailZ + 0.1, mats.body);
    duck.rotation.x = -0.14;

    // ── リア：暗いテールパネル＋左右のスリット赤テール＋暗い凹みプレート＋ボディ色バンパー ──
    box(1.7, 0.24, 0.06, 0, 0.16, W.tailZ - 0.01, AssetGenerator.lambert(0x1a1a1e, false)); // 暗いテールパネル
    for (const s of [-1, 1]) {
      box(0.56, 0.15, 0.06, s * 0.48, 0.16, W.tailZ - 0.03, mats.tail); // 赤テール
      box(0.56, 0.025, 0.07, s * 0.48, 0.16, W.tailZ - 0.03, dark); // スリットの仕切り
    }
    box(0.9, 0.34, 0.05, 0, -0.14, W.tailZ - 0.01, AssetGenerator.lambert(0x0c0c0f, false)); // プレートの暗い凹み
    AssetGenerator.addPlate(group, W.tailZ - 0.03);
    box(2.0, 0.2, 0.4, 0, -0.38, W.tailZ + 0.08, mats.body); // ボディ色バンパー（後ろへ張り出す）
    box(1.6, 0.12, 0.32, 0, -0.6, W.tailZ + 0.08, dark); // 暗いバランス

    return group;
  }

  /** ナンバープレートを後端に貼る（z は車種ごとのリア位置）。商標を避けた汎用表記。 */
  private static addPlate(group: THREE.Group, z: number): void {
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.28, 0.04),
      new THREE.MeshBasicMaterial({ map: AssetGenerator.createPlateTexture() })
    );
    plate.position.set(0, -0.1, z);
    group.add(plate);
  }

  /** ナンバープレートのテクスチャ（商標を避けた汎用のレース用プレート表記） */
  static createPlateTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#f2f2f2";
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = "#1a3a6b";
    ctx.lineWidth = 8;
    ctx.strokeRect(8, 8, 240, 112);
    ctx.fillStyle = "#15305f";
    ctx.font = "bold 56px 'Arial Narrow', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("GP-01", 128, 68);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  /** ドリフト煙用の柔らかい円テクスチャ */
  static createSmokeTexture(): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.5, "rgba(230,230,230,0.5)");
    g.addColorStop(1, "rgba(220,220,220,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }

  /**
   * タイヤ1本（ホイール＋ハブキャップ＋スポーク）。
   * 回転軸がローカル X 軸になるよう geometry を回しておく。
   * → group.rotation.x で転がり、親 group の rotation.y で操舵を表現できる。
   */
  static createWheel(rimColor?: number): THREE.Group {
    const group = new THREE.Group();
    const R = CAR.WHEEL_RADIUS;
    const W = CAR.WHEEL_WIDTH;
    // 回転軸をローカル X 軸にした円柱を作るヘルパー
    const cyl = (r: number, h: number, mat: THREE.Material): THREE.Mesh => {
      const g = new THREE.CylinderGeometry(r, r, h, 16).rotateZ(Math.PI / 2);
      return new THREE.Mesh(g, mat);
    };
    const tireMat = AssetGenerator.lambert(COLOR.WHEEL);
    const rimMat = AssetGenerator.lambert(rimColor ?? COLOR.WHEEL_HUB, false); // 既定は明るいグレー（車種でブロンズ等に変更可）
    const recessMat = AssetGenerator.lambert(0x3a3a3e, false); // 凹みの暗いグレー
    const hubMat = AssetGenerator.lambert(rimColor ?? 0x9c9ca0, false);

    // タイヤ（黒・太い）＋内側の一段濃いトレッド
    group.add(cyl(R, W, tireMat));
    group.add(cyl(R * 0.99, W + 0.02, AssetGenerator.lambert(0x0e0e11)));

    // 左右両面のホイールフェイス（ディッシュ＝グレーの皿＋暗い凹み＋スポーク＋ハブ）
    for (const s of [-1, 1]) {
      const fx = s * (W / 2);
      const dish = cyl(R * 0.78, 0.05, rimMat);
      dish.position.x = fx - s * 0.02; // タイヤ面から少し奥
      group.add(dish);
      const recess = cyl(R * 0.56, 0.06, recessMat);
      recess.position.x = fx + s * 0.005;
      group.add(recess);
      // スポーク（6本・グレー・ハブからリムへ放射）
      for (let i = 0; i < 6; i++) {
        const spokeGeo = new THREE.BoxGeometry(0.05, R * 0.62, 0.12);
        spokeGeo.translate(0, R * 0.42, 0);
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        spoke.position.x = fx + s * 0.02;
        spoke.rotation.x = (i / 6) * Math.PI * 2;
        group.add(spoke);
      }
      // 中央ハブ（盛り上がり）＋暗い中心
      const hub = cyl(R * 0.26, 0.12, hubMat);
      hub.position.x = fx + s * 0.05;
      group.add(hub);
      const hubCenter = cyl(R * 0.12, 0.14, recessMat);
      hubCenter.position.x = fx + s * 0.06;
      group.add(hubCenter);
    }
    return group;
  }

  /** 車の真下に置く簡易ブロブ影（半透明の円） */
  static createBlobShadow(): THREE.Mesh {
    const geo = new THREE.CircleGeometry(1.4, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: COLOR.SHADOW,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }
}
