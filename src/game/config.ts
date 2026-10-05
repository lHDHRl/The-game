import Phaser from 'phaser';
import { GameScene } from './GameScene';

/** Чем больше итераций, тем устойчивее стопка блоков (меньше дрожания и проваливания). */
const PHYSICS_POSITION_ITERATIONS = 12;
const PHYSICS_VELOCITY_ITERATIONS = 10;
const GRAVITY_Y = 1.1;

export function createGame(parent: string): Phaser.Game {
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent,
    width: 960,
    height: 640,
    backgroundColor: '#0f172a',
    scene: [GameScene],
    physics: {
      default: 'matter',
      matter: {
        gravity: { x: 0, y: GRAVITY_Y },
        enableSleeping: true,
        positionIterations: PHYSICS_POSITION_ITERATIONS,
        velocityIterations: PHYSICS_VELOCITY_ITERATIONS,
        debug: false,
      },
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };

  return new Phaser.Game(config);
}
