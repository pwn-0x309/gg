import {
  Application,
  Sprite,
  Graphics,
  RenderTexture,
  Text,
  TilingSprite,
} from "pixi.js";
import {
  RuntimeFlow,
  RuntimeLimits,
  RuntimeLink,
  RuntimeSubsystem,
  RuntimeSystem,
} from "@dataflows/spec";
import {
  SystemSimulator,
  FlowSimulator,
  SimulatorObjectType,
  SimulatorSystemTitle,
  SimulatorObject,
  SimulatorWhiteBox,
} from "@dataflows/simulator";
import { BlockSize } from "./consts.js";

export interface CanvasSimulatorTextures {
  whiteboxA: RenderTexture;
  whiteboxB: RenderTexture;
  blackbox: RenderTexture;
  link: RenderTexture;
  freeSpace: RenderTexture;
}

export function generateCanvasSimulatorTextures(
  app: Application,
): CanvasSimulatorTextures {
  // Whitebox A
  const whiteboxAGraphic = new Graphics()
    .beginFill(0xc0c0c0)
    .drawRect(0, 0, BlockSize, BlockSize)
    .endFill();

  const whiteboxA = app.renderer.generateTexture(whiteboxAGraphic);

  // Whitebox B
  const whiteboxBGraphic = new Graphics()
    .beginFill(0xa0a0a0)
    .drawRect(0, 0, BlockSize, BlockSize)
    .endFill();

  const whiteboxB = app.renderer.generateTexture(whiteboxBGraphic);

  // Blackbox.
  const blackboxGraphic = new Graphics()
    .beginFill(0x000000)
    .drawRect(0, 0, BlockSize, BlockSize)
    .endFill();

  const blackbox = app.renderer.generateTexture(blackboxGraphic);

  // Link.
  const linkGraphic = new Graphics()
    .beginFill(0xff0000)
    .drawRect(0, 0, BlockSize, BlockSize)
    .endFill();

  const link = app.renderer.generateTexture(linkGraphic);

  // Free space.
  const freeSpaceGraphic = new Graphics()
    .beginFill(0x0000ff)
    .drawRect(0, 0, BlockSize, BlockSize)
    .endFill();

  const freeSpace = app.renderer.generateTexture(freeSpaceGraphic);

  return {
    whiteboxA,
    whiteboxB,
    blackbox,
    link,
    freeSpace,
  };
}

export class CanvasSimulator {
  public system: RuntimeSystem;
  private systemSimulator: SystemSimulator;

  constructor(system: RuntimeSystem) {
    this.system = system;
    this.systemSimulator = new SystemSimulator(system);
  }

  getBoundaries() {
    const systemBoundaries = this.systemSimulator.getBoundaries();

    return {
      left: systemBoundaries.left * BlockSize,
      right: systemBoundaries.right * BlockSize,
      top: systemBoundaries.top * BlockSize,
      bottom: systemBoundaries.bottom * BlockSize,
    };
  }

  getObjectsAt(x: number, y: number): SimulatorObject[] {
    const layout = this.systemSimulator.getLayout();

    return layout[x]?.[y] ?? [];
  }

  getSubsystemAt(x: number, y: number): RuntimeSubsystem | null {
    const objects = this.getObjectsAt(x, y);

    const object = objects
      .reverse()
      .find(
        obj =>
          obj.type === SimulatorObjectType.BlackBox ||
          obj.type === SimulatorObjectType.WhiteBox,
      );

    if (object && "system" in object) {
      return object.system as RuntimeSubsystem;
    }

    return null;
  }

  getLinkAt(x: number, y: number): RuntimeLink | null {
    const objects = this.getObjectsAt(x, y);

    const object = objects
      .reverse()
      .find(obj => obj.type === SimulatorObjectType.Link);

    if (object && "link" in object) {
      return object.link as RuntimeLink;
    }

    return null;
  }

  getisSystemTopRightCorner(x: number, y: number): boolean {
    const objects = this.getObjectsAt(x, y);

    return objects.some(
      obj => obj.type === SimulatorObjectType.SystemTopRightCorner,
    );
  }

  getAvailableSpaceForSystemToRender(
    textures: CanvasSimulatorTextures,
    system: RuntimeSubsystem,
  ): Sprite[] {
    const toDraw: Sprite[] = [];

    // Make a simpler copy of layout:
    const rectLayout: number[][] = new Array(RuntimeLimits.MaxSystemHeight);

    for (let i = 0; i < RuntimeLimits.MaxSystemWidth; i++) {
      rectLayout[i] = Array(RuntimeLimits.MaxSystemWidth).fill(0);
    }

    // Find the total area covered by free space.
    let totalArea = 0;

    const nearSystemMargin = (x: number, y: number): boolean => {
      for (const [i, j] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
        [x - 1, y - 1],
        [x + 1, y + 1],
        [x + 1, y - 1],
        [x - 1, y + 1],
      ]) {
        if (
          this.getObjectsAt(i, j).some(
            obj => obj.type === SimulatorObjectType.SystemMargin,
          )
        ) {
          return true;
        }
      }

      return false;
    };

    for (let i = 0; i < RuntimeLimits.MaxSystemWidth; i++) {
      for (let j = 0; j < RuntimeLimits.MaxSystemHeight; j++) {
        const objects = this.getObjectsAt(i, j);

        if (
          objects.some(
            obj =>
              (obj.type === SimulatorObjectType.BlackBox ||
                obj.type === SimulatorObjectType.WhiteBox) &&
              "system" in obj &&
              (obj.system as RuntimeSubsystem).canonicalId ===
                system.canonicalId,
          )
        ) {
          rectLayout[i]![j]! = 1;
          totalArea += 1;
          continue;
        }

        const object = objects.find(
          obj =>
            obj.type === SimulatorObjectType.BlackBox ||
            obj.type === SimulatorObjectType.WhiteBox ||
            obj.type === SimulatorObjectType.Port ||
            obj.type === SimulatorObjectType.SystemMargin,
        );

        if (!object && !nearSystemMargin(i, j)) {
          rectLayout[i]![j]! = 1;
          totalArea += 1;
        }
      }
    }

    // Find all rectangles until the total area is covered.
    let foundArea = 0;

    while (foundArea < totalArea) {
      // Find next rectangle.
      const rect = {
        x1: 0,
        x2: RuntimeLimits.MaxSystemWidth - 1,
        y1: 0,
        y2: RuntimeLimits.MaxSystemHeight - 1,
      };

      findTopLeftCorner: {
        for (let i = 0; i < RuntimeLimits.MaxSystemWidth; i++) {
          for (let j = 0; j < RuntimeLimits.MaxSystemHeight; j++) {
            if (rectLayout[i]![j]! === 1) {
              rect.x1 = i;
              rect.y1 = j;

              break findTopLeftCorner;
            }
          }
        }
      }

      findBottomRightCorner: {
        for (let i = rect.x1; i <= rect.x2; i++) {
          if (rectLayout[i]![rect.y1]! === 0) {
            rect.x2 = i - 1;
            break findBottomRightCorner;
          }

          for (let j = rect.y1; j <= rect.y2; j++) {
            if (rectLayout[i]![j]! === 0) {
              rect.y2 = j - 1;
              break;
            }
          }
        }
      }

      // Mark the rectangle.
      for (let i = rect.x1; i <= rect.x2; i++) {
        for (let j = rect.y1; j <= rect.y2; j++) {
          rectLayout[i]![j]! = 0;
        }
      }

      // Add to found area.
      foundArea += (rect.x2 - rect.x1 + 1) * (rect.y2 - rect.y1 + 1);

      // Create sprite.
      const sprite = new TilingSprite(
        textures.freeSpace,
        (rect.x2 - rect.x1 + 1) * BlockSize,
        (rect.y2 - rect.y1 + 1) * BlockSize,
      );

      sprite.x = rect.x1 * BlockSize;
      sprite.y = rect.y1 * BlockSize;

      toDraw.push(sprite);

      // failsafe.
      if (toDraw.length > 1000) {
        return toDraw;
      }
    }

    return toDraw;
  }

  getObjectsToRender(textures: CanvasSimulatorTextures): (Sprite | Text)[] {
    const toDraw: (Sprite | Text)[] = [];
    const layout = this.systemSimulator.getLayout();

    for (let i = 0; i < RuntimeLimits.MaxSystemWidth; i++) {
      for (let j = 0; j < RuntimeLimits.MaxSystemHeight; j++) {
        for (const obj of layout[i]![j]!) {
          if (obj.type === SimulatorObjectType.WhiteBox) {
            const { system } = obj as SimulatorWhiteBox;

            const sprite = new Sprite(
              system.depth % 2 === 0 ? textures.whiteboxA : textures.whiteboxB,
            );

            sprite.x = i * BlockSize;
            sprite.y = j * BlockSize;

            toDraw.push(sprite);
          } else if (obj.type === SimulatorObjectType.BlackBox) {
            const sprite = new Sprite(textures.blackbox);

            sprite.x = i * BlockSize;
            sprite.y = j * BlockSize;

            toDraw.push(sprite);
          } else if (obj.type === SimulatorObjectType.Link) {
            const sprite = new Sprite(textures.link);

            sprite.x = i * BlockSize;
            sprite.y = j * BlockSize;

            toDraw.push(sprite);
          } else if (obj.type === SimulatorObjectType.SystemTitle) {
            const title = new Text((obj as SimulatorSystemTitle).chars, {
              fontFamily: "Ibm",
              fontSize: BlockSize,
            });

            title.x = i * BlockSize;
            title.y = j * BlockSize;
            title.style.fill = "0xffffff";
            title.resolution = 2;

            toDraw.push(title);
          }
        }
      }
    }

    return toDraw;
  }

  createFlowPlayer(app: Application, flowIndex: number): CanvasFlowPlayer {
    const dataGraphic = new Graphics()
      .beginFill(0x00ff00)
      .drawRect(0, 0, BlockSize, BlockSize)
      .endFill();

    const dataTexture = app.renderer.generateTexture(dataGraphic);

    return new CanvasFlowPlayer(
      this.systemSimulator,
      this.system.flows.find(flow => flow.index === flowIndex)!,
      dataTexture,
    );
  }
}

export class CanvasFlowPlayer {
  private flowSimulator: FlowSimulator;
  private maxKeyframes: number;
  private currentKeyframe: number;
  private currentKeyframeProgress: number;
  private sprites: Sprite[];

  constructor(
    simulator: SystemSimulator,
    flow: RuntimeFlow,
    dataTexture: RenderTexture,
  ) {
    this.flowSimulator = new FlowSimulator(simulator, flow);

    this.currentKeyframe = 0;
    this.currentKeyframeProgress = 0;

    // @ts-ignore FIXME
    this.maxKeyframes = Math.max(...flow.steps.map(step => step.keyframe)) + 1;

    // @ts-ignore FIXME
    this.sprites = flow.steps.map(() => new Sprite(dataTexture));
  }

  getObjectsToRender(): Sprite[] {
    return this.sprites;
  }

  update(deltaTime: number): void {
    this.currentKeyframeProgress += 0.01 * deltaTime;

    if (this.currentKeyframeProgress > 1) {
      this.currentKeyframeProgress %= 1;
      this.currentKeyframe += 1;
    }

    this.currentKeyframe %= this.maxKeyframes;

    const data = this.flowSimulator.tick({
      keyframe: this.currentKeyframe,
      keyframeProgress: this.currentKeyframeProgress,
    });

    for (let i = 0; i < data.length; i++) {
      this.sprites[i].x = data[i][0] * BlockSize;
      this.sprites[i].y = data[i][1] * BlockSize;
    }
  }
}
