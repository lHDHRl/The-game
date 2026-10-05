import Phaser from 'phaser';

// --- Мир ---
const PEDESTAL_WIDTH = 220;
const PEDESTAL_HEIGHT = 120;
/** Блок, упавший ниже верха пьедестала на столько пикселей, считается потерянным. */
const FALL_LIMIT = 160;

// --- Блоки ---
const BLOCK_START_WIDTH = 130;
const BLOCK_MIN_WIDTH = 70;
/** На сколько пикселей блок становится уже с каждым поставленным этажом. */
const BLOCK_SHRINK_PER_FLOOR = 2;
const BLOCK_HEIGHT = 40;
const BLOCK_FRICTION = 0.9;
const BLOCK_STATIC_FRICTION = 1;
const BLOCK_DENSITY = 0.002;
const BLOCK_CHAMFER = 3;
/** Сколько верхних этажей остаются «живыми». Нижние замораживаются, чтобы высокая башня не дрожала. */
const DYNAMIC_FLOORS = 6;

// --- Кран ---
/** Высота, на которой блок висит над вершиной башни. */
const CRANE_GAP = 150;
/** Какая доля скорости крана передаётся блоку при отпускании (1 = вся). */
const CRANE_INERTIA = 0.5;
const CRANE_AMPLITUDE = 230;
const CRANE_BASE_SPEED = 1.6; // рад/с
const CRANE_SPEED_PER_FLOOR = 0.05;
const CRANE_MAX_SPEED = 3.6;

// --- Приземление ---
/** Блок считается вставшим, если он почти не двигается столько миллисекунд. */
const SETTLE_TIME_MS = 350;
const SETTLE_SPEED = 0.25;
const SETTLE_ANGULAR_SPEED = 0.01;
/** Если блок долго не успокаивается, он всё равно засчитывается (лишь бы не упал). */
const MAX_FALL_TIME_MS = 5000;
const PERFECT_TOLERANCE = 6;
const PERFECT_BONUS = 1;

// --- Камера ---
/** Где на экране держать вершину башни (доля высоты сверху). */
const CAMERA_TOP_ANCHOR = 0.62;
const CAMERA_LERP = 0.06;

/** Подсказка висит под счётом, чтобы её не перекрывал кран. */
const HINT_Y = 120;

const GAME_OVER_TIME_SCALE = 0.45;
const RESTART_DELAY_MS = 700;
const BEST_SCORE_KEY = 'tower-stack-best';

type State = 'aiming' | 'falling' | 'over';

interface Block {
  body: MatterJS.BodyType;
  view: Phaser.GameObjects.Rectangle;
}

/**
 * Tower Stack: блок качается на кране, игрок отпускает его, и блок падает
 * на башню по законам физики (Matter.js). Блок сохраняет скорость крана,
 * поэтому важен момент отпускания. Если хоть один блок свалится с башни,
 * игра заканчивается.
 */
export class GameScene extends Phaser.Scene {
  private state: State = 'aiming';
  private placed: Block[] = [];
  private falling: Block | null = null;
  private hook!: Phaser.GameObjects.Rectangle;
  private rope!: Phaser.GameObjects.Graphics;
  private craneTime = 0;
  private settleTimer = 0;
  private fallTimer = 0;
  private overAt = 0;
  private score = 0;
  private best = 0;
  private pedestalTop = 0;
  private towerX = 0;
  private scoreText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;

  constructor() {
    super('GameScene');
  }

  create(): void {
    const { width, height } = this.scale;

    this.state = 'aiming';
    this.placed = [];
    this.falling = null;
    this.craneTime = 0;
    this.score = 0;
    this.best = loadBest();
    this.towerX = width / 2;
    this.pedestalTop = height - PEDESTAL_HEIGHT;
    this.matter.world.engine.timing.timeScale = 1;
    this.cameras.main.setScroll(0, 0);

    this.createPedestal();
    this.rope = this.add.graphics();
    this.hook = this.add.rectangle(0, 0, this.blockWidth(), BLOCK_HEIGHT, this.blockColor(0));
    this.hook.setStrokeStyle(2, 0xffffff, 0.35);
    this.createUi();
    this.positionHook();

    this.input.on('pointerdown', () => this.handleAction());
    this.input.keyboard?.on('keydown-SPACE', () => this.handleAction());
    this.input.keyboard?.on('keydown-R', () => {
      if (this.state === 'over') this.scene.restart();
    });
  }

  update(_time: number, delta: number): void {
    this.syncViews();

    if (this.state === 'aiming') {
      this.craneTime += delta / 1000;
      this.positionHook();
    } else if (this.state === 'falling') {
      this.checkFallingBlock(delta);
    }

    if (this.state !== 'over' && this.hasLostBlock()) {
      this.gameOver();
    }

    this.followTower();
  }

  // ---------- Действие игрока ----------

  private handleAction(): void {
    if (this.state === 'aiming') {
      this.dropBlock();
    } else if (this.state === 'over' && this.time.now - this.overAt > RESTART_DELAY_MS) {
      this.scene.restart();
    }
  }

  private dropBlock(): void {
    const width = this.hook.width;
    const body = this.matter.add.rectangle(this.hook.x, this.hook.y, width, BLOCK_HEIGHT, {
      friction: BLOCK_FRICTION,
      frictionStatic: BLOCK_STATIC_FRICTION,
      restitution: 0,
      density: BLOCK_DENSITY,
      chamfer: { radius: BLOCK_CHAMFER },
    });
    // Блок уносит с собой скорость крана: отпускать нужно с упреждением.
    // Скорость в Matter измеряется в пикселях за шаг (1/60 с).
    this.matter.body.setVelocity(body, { x: (this.craneVelocityX() * CRANE_INERTIA) / 60, y: 0 });

    const view = this.add.rectangle(body.position.x, body.position.y, width, BLOCK_HEIGHT, this.hook.fillColor);
    view.setStrokeStyle(2, 0xffffff, 0.35);

    this.falling = { body, view };
    this.hook.setVisible(false);
    this.rope.clear();
    this.settleTimer = 0;
    this.fallTimer = 0;
    this.state = 'falling';
  }

  // ---------- Падение и приземление ----------

  private checkFallingBlock(delta: number): void {
    if (!this.falling) return;
    const { body } = this.falling;

    this.fallTimer += delta;
    const isCalm = body.speed < SETTLE_SPEED && body.angularSpeed < SETTLE_ANGULAR_SPEED;
    this.settleTimer = isCalm || body.isSleeping ? this.settleTimer + delta : 0;

    const aboveTower = body.position.y < this.pedestalTop;
    const timedOut = this.fallTimer >= MAX_FALL_TIME_MS && this.restsOnTower(body);
    if (aboveTower && (this.settleTimer >= SETTLE_TIME_MS || timedOut)) {
      this.landBlock(this.falling);
    }
  }

  /** Лежит ли блок над предыдущим этажом (или над пьедесталом), а не сползает с края. */
  private restsOnTower(body: MatterJS.BodyType): boolean {
    const previous = this.placed[this.placed.length - 1];
    const supportX = previous ? previous.body.position.x : this.towerX;
    const supportWidth = previous ? previous.view.width : PEDESTAL_WIDTH;
    const width = body.bounds.max.x - body.bounds.min.x;
    return Math.abs(body.position.x - supportX) < (supportWidth + width) / 2;
  }

  private landBlock(block: Block): void {
    const previous = this.placed[this.placed.length - 1];
    const offset = previous ? Math.abs(block.body.position.x - previous.body.position.x) : Infinity;
    const isPerfect = offset <= PERFECT_TOLERANCE;

    this.placed.push(block);
    this.falling = null;
    this.score += 1 + (isPerfect ? PERFECT_BONUS : 0);
    this.updateScoreText();
    this.freezeLowerFloors();
    this.flashBlock(block.view);
    this.hintText.setVisible(false);

    if (isPerfect) this.showPopup(block.view.x, block.view.y - 40, 'ИДЕАЛЬНО! +1');

    this.hook.setSize(this.blockWidth(), BLOCK_HEIGHT);
    this.hook.setFillStyle(this.blockColor(this.placed.length));
    this.hook.setVisible(true);
    this.state = 'aiming';
    this.positionHook();
  }

  /** Нижние этажи становятся статичными: башня остаётся устойчивой и не тормозит. */
  private freezeLowerFloors(): void {
    const frozenCount = this.placed.length - DYNAMIC_FLOORS;
    for (let i = 0; i < frozenCount; i++) {
      const { body } = this.placed[i];
      if (!body.isStatic) this.matter.body.setStatic(body, true);
    }
  }

  private hasLostBlock(): boolean {
    const limit = this.pedestalTop + FALL_LIMIT;
    if (this.falling && this.falling.body.position.y > limit) return true;
    return this.placed.some((block) => block.body.position.y > limit);
  }

  private gameOver(): void {
    const towerFell = this.placed.some((block) => block.body.position.y > this.pedestalTop + FALL_LIMIT);
    this.state = 'over';
    this.overAt = this.time.now;
    this.hook.setVisible(false);
    this.hintText.setVisible(false);
    this.rope.clear();
    // Замедление, чтобы игрок увидел, как рушится башня.
    this.matter.world.engine.timing.timeScale = GAME_OVER_TIME_SCALE;
    this.cameras.main.shake(300, 0.01);

    if (this.score > this.best) {
      this.best = this.score;
      saveBest(this.best);
    }
    this.showGameOverPanel(towerFell ? 'Башня рухнула!' : 'Блок упал!');
  }

  // ---------- Кран ----------

  private craneSpeed(): number {
    return Math.min(CRANE_BASE_SPEED + this.placed.length * CRANE_SPEED_PER_FLOOR, CRANE_MAX_SPEED);
  }

  /** Горизонтальная скорость крана в пикселях в секунду. */
  private craneVelocityX(): number {
    const speed = this.craneSpeed();
    return Math.cos(this.craneTime * speed) * speed * CRANE_AMPLITUDE;
  }

  private positionHook(): void {
    const x = this.towerX + Math.sin(this.craneTime * this.craneSpeed()) * CRANE_AMPLITUDE;
    const y = this.towerTop() - CRANE_GAP;
    this.hook.setPosition(x, y);

    const ropeTop = this.cameras.main.scrollY - 10;
    this.rope.clear();
    this.rope.lineStyle(2, 0x94a3b8, 0.8);
    this.rope.lineBetween(x, ropeTop, x, y - BLOCK_HEIGHT / 2);
  }

  // ---------- Геометрия башни ----------

  private towerTop(): number {
    let top = this.pedestalTop;
    for (const block of this.placed) top = Math.min(top, block.body.bounds.min.y);
    return top;
  }

  private blockWidth(): number {
    return Math.max(BLOCK_START_WIDTH - this.placed.length * BLOCK_SHRINK_PER_FLOOR, BLOCK_MIN_WIDTH);
  }

  private blockColor(floor: number): number {
    const hue = (0.55 + floor * 0.04) % 1;
    return Phaser.Display.Color.HSLToColor(hue, 0.7, 0.58).color;
  }

  private createPedestal(): void {
    const x = this.towerX;
    const y = this.pedestalTop + PEDESTAL_HEIGHT / 2;
    this.matter.add.rectangle(x, y, PEDESTAL_WIDTH, PEDESTAL_HEIGHT, {
      isStatic: true,
      friction: BLOCK_FRICTION,
      frictionStatic: BLOCK_STATIC_FRICTION,
    });
    this.add.rectangle(x, y, PEDESTAL_WIDTH, PEDESTAL_HEIGHT, 0x334155).setStrokeStyle(2, 0x64748b);
  }

  private syncViews(): void {
    const blocks = this.falling ? [...this.placed, this.falling] : this.placed;
    for (const { body, view } of blocks) {
      view.setPosition(body.position.x, body.position.y);
      view.setRotation(body.angle);
    }
  }

  private followTower(): void {
    const camera = this.cameras.main;
    const target = Math.min(0, this.towerTop() - this.scale.height * CAMERA_TOP_ANCHOR);
    camera.scrollY = Phaser.Math.Linear(camera.scrollY, target, CAMERA_LERP);
  }

  // ---------- Интерфейс и обратная связь ----------

  private createUi(): void {
    const { width } = this.scale;
    this.scoreText = this.add
      .text(width / 2, 24, '', { fontFamily: 'system-ui, sans-serif', fontSize: '44px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(10);
    this.updateScoreText();

    this.hintText = this.add
      .text(width / 2, HINT_Y, 'Клик / Пробел — отпустить блок\nБлок летит по инерции крана. Не урони ни одного!', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '22px',
        color: '#cbd5e1',
        align: 'center',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(10);
  }

  private updateScoreText(): void {
    this.scoreText.setText(`${this.score}`);
  }

  private flashBlock(view: Phaser.GameObjects.Rectangle): void {
    const color = view.fillColor;
    view.setFillStyle(0xffffff);
    this.time.delayedCall(90, () => view.setFillStyle(color));
  }

  private showPopup(x: number, y: number, message: string): void {
    const text = this.add
      .text(x, y, message, { fontFamily: 'system-ui, sans-serif', fontSize: '26px', color: '#facc15', fontStyle: 'bold' })
      .setOrigin(0.5)
      .setDepth(10);
    this.tweens.add({ targets: text, y: y - 60, alpha: 0, duration: 900, onComplete: () => text.destroy() });
  }

  private showGameOverPanel(title: string): void {
    const { width, height } = this.scale;
    this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.55).setScrollFactor(0).setDepth(20);
    this.add
      .text(width / 2, height / 2, `${title}\n\nСчёт: ${this.score}\nРекорд: ${this.best}\n\nКлик / Пробел / R — заново`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '30px',
        color: '#ffffff',
        align: 'center',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(21);
  }
}

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest(value: number): void {
  try {
    localStorage.setItem(BEST_SCORE_KEY, String(value));
  } catch {
    // localStorage может быть недоступен (приватный режим) — рекорд просто не сохранится.
  }
}
