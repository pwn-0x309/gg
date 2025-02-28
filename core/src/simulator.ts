import { Grid as PathFinderGrid, findPath } from "./pathfinding.js";
import {
  RuntimeSystem,
  RuntimeSubsystem,
  RuntimeLink,
  RuntimePosition,
} from "./runtime.js";
import {
  PaddingWhiteBox,
  TitleCharsPerSquare,
  SystemMargin,
} from "./consts.js";

export enum SimulatorObjectType {
  System = 1,
  Port = 2,
  Link = 3,
  SystemMargin = 4,
  SystemTitle = 5,
  SystemTitlePadding = 6,
}

export enum SimulatorLinkDirectionType {
  Horizontal = 1,
  Vertical = 2,
  BottomToRight = 3,
  BottomToLeft = 4,
  TopToRight = 5,
  TopToLeft = 6,
}

export enum SimulatorSystemDirectionType {
  TopLeft = 1,
  TopCenter = 2,
  TopRight = 3,
  CenterLeft = 4,
  CenterCenter = 5,
  CenterRight = 6,
  BottomLeft = 7,
  BottomCenter = 8,
  BottomRight = 9,
}

export interface SimulatorObject {
  type: SimulatorObjectType;
}

export interface SimulatorSubsystem extends SimulatorObject {
  type: SimulatorObjectType.System;
  system: RuntimeSubsystem;
  direction: SimulatorSystemDirectionType;
  blackbox: boolean;
}

export interface SimulatorPort extends SimulatorObject {
  type: SimulatorObjectType.Port;
  system: RuntimeSubsystem;
}

export interface SimulatorLink extends SimulatorObject {
  type: SimulatorObjectType.Link;
  direction: SimulatorLinkDirectionType;
  link: RuntimeLink;
}

export interface SimulatorSystemMargin extends SimulatorObject {
  type: SimulatorObjectType.SystemMargin;
  system: RuntimeSystem | RuntimeSubsystem;
}

export interface SimulatorSystemTitle extends SimulatorObject {
  type: SimulatorObjectType.SystemTitle;
  system: RuntimeSubsystem;
  blackbox: boolean;
  chars: string;
}

export interface SimulatorSystemTitlePadding extends SimulatorObject {
  type: SimulatorObjectType.SystemTitlePadding;
  system: RuntimeSubsystem;
  blackbox: boolean;
}

export interface SimulatorBoundaries {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  translateX: number;
  translateY: number;
}

interface GridSystem {
  id: string;

  /* Left position in a 2D grid. Always >= 0. */
  x1: number;

  /* Right position in a 2D grid. Always >= 0. */
  x2: number;

  /* Y position in a 2D grid. Always >= 0. */
  y1: number;

  /* Bottom position in a 2D grid. Always >= 0. */
  y2: number;

  /* X position in an infinite grid. Can be ]-inf, inf[. */
  worldX: number;

  /* Y position in an infinite grid. Can be ]-inf, inf[. */
  worldY: number;

  width: number;
  height: number;
  ports: {
    x: number;
    y: number;
  }[];
  title: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  hidden: boolean;
}

export class SystemSimulator {
  private system: RuntimeSystem;
  private routes: Record<string, Record<string, number[][]>>;
  private gridSystems: Record<string, GridSystem>;
  private grid: SimulatorObject[][][];
  private boundaries: SimulatorBoundaries;

  constructor(options: {
    system: RuntimeSystem;
    routes?: Record<string, Record<string, number[][]>>;
    gridSystems?: Record<string, GridSystem>;
    grid?: SimulatorObject[][][];
    boundaries?: SimulatorBoundaries;
  }) {
    this.system = options.system;
    this.routes = options.routes ?? {};
    this.gridSystems = options.gridSystems ?? {};
    this.grid = options.grid ?? [];
    this.boundaries = options.boundaries ?? this.computeBoundaries();
  }

  compute(): void {
    // Compute grid systems. Part I.
    this.initializeSystems(this.system);
    this.computeSystemVisibility(this.system, false);
    this.computeSystemWorldPositions(this.system);
    this.computeSystemSizes(this.system);

    // Compute boundaries.
    this.boundaries = this.computeBoundaries();

    // Compute grid systems. Part II.
    // Requires sizes & boundaries.
    this.computeSystemPositions();

    // Compute grid systems. Part III.
    // Requires positions.
    this.computeSystemPorts(this.system);
    this.computeSystemTitles(this.system);

    // Create grid.
    this.grid = new Array(this.boundaries.height);

    for (let i = 0; i < this.boundaries.width; i++) {
      this.grid[i] = Array.from({ length: this.boundaries.height }, () => []);
    }

    // Create path finder (routing) grid.
    const finderGrid = new PathFinderGrid(
      this.boundaries.width,
      this.boundaries.height,
      1,
    );

    // Draw grid objects.
    this.drawSubsystems(this.system, finderGrid);
    this.drawLinks(this.system, finderGrid);

    this.synchronizeRuntimeObjects(this.system);
  }

  getSystem(): RuntimeSystem {
    return this.system;
  }

  getLayout(): SimulatorObject[][][] {
    return this.grid;
  }

  getBoundaries(): SimulatorBoundaries {
    return this.boundaries;
  }

  // Get the boundaries of the visible system,
  // once it has been drawn on the grid.
  // i.e. a rectangle that encompass all sub-systems, links, etc.
  getVisibleWorldBoundaries(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } {
    let left = this.boundaries.width;
    let right = 0;
    let top = this.boundaries.height;
    let bottom = 0;

    for (let i = 0; i < this.boundaries.width; i++) {
      for (let j = 0; j < this.boundaries.height; j++) {
        const hasVisibleObjects = this.grid[i]![j]!.some(
          obj =>
            obj.type === SimulatorObjectType.System ||
            obj.type === SimulatorObjectType.Link,
        );

        if (!hasVisibleObjects) {
          continue;
        }

        if (i < left) {
          left = i;
        }

        if (i > right) {
          right = i;
        }

        if (j < top) {
          top = j;
        }

        if (j > bottom) {
          bottom = j;
        }
      }
    }

    // Happens when nothing is visible on the grid.
    if (left > right) {
      left = right;
    }

    if (top > bottom) {
      top = bottom;
    }

    return {
      left: left - this.boundaries.translateX,
      right: right - this.boundaries.translateX,
      top: top - this.boundaries.translateY,
      bottom: bottom - this.boundaries.translateY,
    };
  }

  getObjectsAt(worldX: number, worldY: number): SimulatorObject[] {
    const gridX = worldX + this.boundaries.translateX;
    const gridY = worldY + this.boundaries.translateY;

    return this.grid[gridX]?.[gridY] ?? [];
  }

  getSubsystemAt(worldX: number, worldY: number): RuntimeSubsystem | null {
    const objects = this.getObjectsAt(worldX, worldY);

    // Traverse the objects from bottom to top first to detect a blackbox.
    for (const obj of objects) {
      if ("blackbox" in obj && obj.blackbox) {
        return (obj as SimulatorSubsystem).system;
      }
    }

    // Traverse the objects from top to bottom to detect a whitebox.
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i]!;

      if (
        obj.type === SimulatorObjectType.System ||
        obj.type === SimulatorObjectType.SystemTitle ||
        obj.type === SimulatorObjectType.SystemTitlePadding
      ) {
        return (obj as SimulatorSubsystem).system;
      }
    }

    return null;
  }

  getLinkAt(worldX: number, worldY: number): RuntimeLink | null {
    const objects = this.getObjectsAt(worldX, worldY);

    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i]!;

      if (obj.type === SimulatorObjectType.Link) {
        return (obj as SimulatorLink).link;
      }
    }

    return null;
  }

  getRoute(fromSystemId: string, toSystemId: string): number[][] | undefined {
    return this.routes[fromSystemId]?.[toSystemId];
  }

  // Child systems in a parent system are offset
  // by padding (X, Y) and a title (Y).
  //
  // For example, in the example below, the subsystems Foo and Bar are
  // offset by { x: 1, y: 2 }
  //
  //+--------------------------+
  //| +----------------------+ | <- padding of [1, 1]
  //| | Title <- takes y: 1  | |
  //| | +-----+    +-----+   | |
  //| | | Foo |====| Bar |   | |
  //| | +-----+    +-----+   | |
  //| +----------------------+ |
  //+--------------------------+
  getParentOffset(subsystem: RuntimeSubsystem): RuntimePosition {
    return {
      x: PaddingWhiteBox,
      y:
        PaddingWhiteBox +
        subsystem.titlePosition.y +
        subsystem.titleSize.height -
        1,
    };
  }

  private initializeSystems(system: RuntimeSystem | RuntimeSubsystem): void {
    // Recursive traversal.
    for (const ss of system.systems) {
      this.initializeSystems(ss);
    }

    // Root system.
    if (!system.id) {
      return;
    }

    // Initialize system.
    const gridSystem: GridSystem = {
      id: system.id,
      x1: -1,
      x2: -1,
      y1: -1,
      y2: -1,
      worldX: -1,
      worldY: -1,
      width: -1,
      height: -1,
      ports: [],
      title: {
        x: -1,
        y: -1,
        width: -1,
        height: -1,
      },
      hidden: false,
    };

    this.gridSystems[system.id] = gridSystem;
  }

  private computeSystemVisibility(
    system: RuntimeSystem | RuntimeSubsystem,
    hidden: boolean,
  ): void {
    // Recursive traversal.
    for (const ss of system.systems) {
      this.computeSystemVisibility(ss, hidden || (system.hideSystems ?? false));
    }

    // Root system.
    if (!system.id) {
      return;
    }

    const gridSystem = this.gridSystems[system.id]!;

    gridSystem.hidden = hidden;
  }

  private computeSystemWorldPositions(
    system: RuntimeSystem | RuntimeSubsystem,
  ): void {
    const gridSystem = system.id
      ? this.gridSystems[system.id]!
      : { worldX: 0, worldY: 0 };

    for (const ss of system.systems) {
      const ssGridSystem = this.gridSystems[ss.id]!;

      ssGridSystem.worldX = gridSystem.worldX + ss.position.x;
      ssGridSystem.worldY = gridSystem.worldY + ss.position.y;

      if (system.id) {
        const offset = this.getParentOffset(system);

        ssGridSystem.worldX += offset.x;
        ssGridSystem.worldY += offset.y;
      }

      // Recursive traversal.
      this.computeSystemWorldPositions(ss);
    }
  }

  private computeSystemPositions(): void {
    for (const obj of Object.values(this.gridSystems)) {
      obj.x1 = obj.worldX + this.boundaries.translateX;
      obj.x2 = obj.x1 + obj.width - 1;
      obj.y1 = obj.worldY + this.boundaries.translateY;
      obj.y2 = obj.y1 + obj.height - 1;
    }
  }

  private computeSystemSizes(system: RuntimeSystem | RuntimeSubsystem): void {
    for (const ss of system.systems) {
      // Recursive traversal.
      this.computeSystemSizes(ss);
    }

    // Root system.
    if (!system.id) {
      return;
    }

    const gridSystem = this.gridSystems[system.id]!;

    gridSystem.width = system.size.width;
    gridSystem.height = system.size.height;
  }

  private computeSystemPorts(system: RuntimeSystem | RuntimeSubsystem): void {
    for (const ss of system.systems) {
      const gridSystem = this.gridSystems[ss.id]!;

      gridSystem.ports = ss.ports.map(port => ({
        x: gridSystem.x1 + port.x,
        y: gridSystem.y1 + port.y,
      }));

      // Recursive traversal.
      this.computeSystemPorts(ss);
    }
  }

  private computeSystemTitles(system: RuntimeSystem | RuntimeSubsystem): void {
    // Recursive traversal.
    for (const ss of system.systems) {
      this.computeSystemTitles(ss);
    }

    // Root system.
    if (!system.id) {
      return;
    }

    const gridSystem = this.gridSystems[system.id]!;

    gridSystem.title = {
      x: gridSystem.x1 + system.titlePosition.x,
      y: gridSystem.y1 + system.titlePosition.y,
      width: system.titleSize.width,
      height: system.titleSize.height,
    };
  }

  private computeBoundaries(): SimulatorBoundaries {
    let left = Number.MAX_SAFE_INTEGER;
    let right = 0;
    let top = Number.MAX_SAFE_INTEGER;
    let bottom = 0;

    for (const obj of Object.values(this.gridSystems)) {
      if (obj.worldX < left) {
        left = obj.worldX;
      }

      if (obj.worldX + obj.width > right) {
        right = obj.worldX + obj.width;
      }

      if (obj.worldY < top) {
        top = obj.worldY;
      }

      if (obj.worldY + obj.height > bottom) {
        bottom = obj.worldY + obj.height;
      }
    }

    // Happens when there are no subsystems.
    if (left > right) {
      left = right;
    }

    if (top > bottom) {
      top = bottom;
    }

    // Apply system margins.
    left -= SystemMargin * 5;
    right += SystemMargin * 5;
    top -= SystemMargin * 5;
    bottom += SystemMargin * 5;

    return {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
      translateX: left < 0 ? Math.abs(left) : -left,
      translateY: top < 0 ? Math.abs(top) : -top,
    };
  }

  private drawSubsystems(
    system: RuntimeSystem | RuntimeSubsystem,
    finderGrid: PathFinderGrid,
  ): void {
    for (const ss of system.systems) {
      const gridSS = this.gridSystems[ss.id]!;

      // Draw margins.
      const simulatorSystemMargin: SimulatorSystemMargin = Object.freeze({
        type: SimulatorObjectType.SystemMargin,
        system: ss,
      });

      for (
        let x = gridSS.x1 - SystemMargin;
        x <= gridSS.x2 + SystemMargin;
        x++
      ) {
        const top = gridSS.y1 - SystemMargin;
        const bottom = gridSS.y2 + SystemMargin;

        this.grid[x]![top]!.push(simulatorSystemMargin);
        finderGrid.setWeightAt(x, top, Infinity);

        this.grid[x]![bottom]!.push(simulatorSystemMargin);
        finderGrid.setWeightAt(x, bottom, Infinity);
      }

      for (
        let y = gridSS.y1 - SystemMargin;
        y <= gridSS.y2 + SystemMargin;
        y++
      ) {
        const left = gridSS.x1 - SystemMargin;
        const right = gridSS.x2 + SystemMargin;

        this.grid[left]![y]!.push(simulatorSystemMargin);
        finderGrid.setWeightAt(left, y, Infinity);

        this.grid[right]![y]!.push(simulatorSystemMargin);
        finderGrid.setWeightAt(right, y, Infinity);
      }

      // Sub-systems.
      const blackbox = gridSS.hidden || ss.hideSystems || !ss.systems.length;

      const simulatorSystem: SimulatorSubsystem = Object.freeze({
        type: SimulatorObjectType.System,
        blackbox,
        system: ss,
        direction: SimulatorSystemDirectionType.CenterCenter,
      });

      const simulatorSystemTopLeftCorner: SimulatorSubsystem = Object.freeze({
        type: SimulatorObjectType.System,
        blackbox,
        system: ss,
        direction: SimulatorSystemDirectionType.TopLeft,
      });

      const simulatorSystemTopRightCorner: SimulatorSubsystem = Object.freeze({
        type: SimulatorObjectType.System,
        blackbox,
        system: ss,
        direction: SimulatorSystemDirectionType.TopRight,
      });

      const simulatorSystemBottomLeftCorner: SimulatorSubsystem = Object.freeze(
        {
          type: SimulatorObjectType.System,
          blackbox,
          system: ss,
          direction: SimulatorSystemDirectionType.BottomLeft,
        },
      );

      const simulatorSystemBottomRightCorner: SimulatorSubsystem =
        Object.freeze({
          type: SimulatorObjectType.System,
          blackbox,
          system: ss,
          direction: SimulatorSystemDirectionType.BottomRight,
        });

      const simulatorSystemLeft: SimulatorSubsystem = Object.freeze({
        type: SimulatorObjectType.System,
        blackbox,
        system: ss,
        direction: SimulatorSystemDirectionType.CenterLeft,
      });

      const simulatorSystemRight: SimulatorSubsystem = Object.freeze({
        type: SimulatorObjectType.System,
        blackbox,
        system: ss,
        direction: SimulatorSystemDirectionType.CenterRight,
      });

      const simulatorSystemTop: SimulatorSubsystem = Object.freeze({
        type: SimulatorObjectType.System,
        blackbox,
        system: ss,
        direction: SimulatorSystemDirectionType.TopCenter,
      });

      const simulatorSystemBottom: SimulatorSubsystem = Object.freeze({
        type: SimulatorObjectType.System,
        blackbox,
        system: ss,
        direction: SimulatorSystemDirectionType.BottomCenter,
      });

      for (let x = gridSS.x1; x <= gridSS.x2; x++) {
        for (let y = gridSS.y1; y <= gridSS.y2; y++) {
          if (ss.systems.length) {
            finderGrid.setWeightAt(x, y, 1);
          } else {
            finderGrid.setWeightAt(x, y, Infinity);
          }

          // The sub-system is inside a blackbox.
          if (gridSS.hidden) {
            continue;
          }

          if (x === gridSS.x1 && y == gridSS.y1) {
            this.grid[x]![y]!.push(simulatorSystemTopLeftCorner);
          } else if (x === gridSS.x2 && y == gridSS.y1) {
            this.grid[x]![y]!.push(simulatorSystemTopRightCorner);
          } else if (x === gridSS.x1 && y == gridSS.y2) {
            this.grid[x]![y]!.push(simulatorSystemBottomLeftCorner);
          } else if (x === gridSS.x2 && y == gridSS.y2) {
            this.grid[x]![y]!.push(simulatorSystemBottomRightCorner);
          } else if (x === gridSS.x1) {
            this.grid[x]![y]!.push(simulatorSystemLeft);
          } else if (x === gridSS.x2) {
            this.grid[x]![y]!.push(simulatorSystemRight);
          } else if (y === gridSS.y1) {
            this.grid[x]![y]!.push(simulatorSystemTop);
          } else if (y === gridSS.y2) {
            this.grid[x]![y]!.push(simulatorSystemBottom);
          } else {
            this.grid[x]![y]!.push(simulatorSystem);
          }
        }
      }

      // Ports.
      const simulatorPort: SimulatorPort = Object.freeze({
        type: SimulatorObjectType.Port,
        system: ss,
      });

      for (const port of gridSS.ports) {
        this.grid[port.x]![port.y]!.push(simulatorPort);
        finderGrid.setWeightAt(port.x, port.y, 1);
      }

      // Title padding.
      const simulatorSystemTitlePadding: SimulatorSystemTitlePadding =
        Object.freeze({
          type: SimulatorObjectType.SystemTitlePadding,
          blackbox,
          system: ss,
        });

      for (
        let x = gridSS.title.x - 1;
        x < gridSS.title.x + gridSS.title.width + 1;
        x++
      ) {
        for (
          let y = gridSS.title.y - 1;
          y < gridSS.title.y + gridSS.title.height + 1;
          y++
        ) {
          this.grid[x]![y]!.push(simulatorSystemTitlePadding);
          finderGrid.setWeightAt(x, y, Infinity);
        }
      }

      // Title.
      const titleLines = ss.title.split("\\n");

      for (
        let x = gridSS.title.x, i = 0;
        x < gridSS.title.x + gridSS.title.width;
        x++, i++
      ) {
        for (
          let y = gridSS.title.y, j = 0;
          y < gridSS.title.y + gridSS.title.height;
          y++, j++
        ) {
          finderGrid.setWeightAt(x, y, Infinity);

          // The sub-system is inside a blackbox.
          if (gridSS.hidden) {
            continue;
          }

          const simulatorSystemTitle: SimulatorSystemTitle = {
            type: SimulatorObjectType.SystemTitle,
            system: ss,
            blackbox,
            chars: titleLines[j]!.slice(
              i * TitleCharsPerSquare,
              i * TitleCharsPerSquare + TitleCharsPerSquare,
            ),
          };

          this.grid[x]![y]!.push(simulatorSystemTitle);
        }
      }

      // Recursive traversal.
      this.drawSubsystems(ss, finderGrid);
    }
  }

  private drawLinks(system: RuntimeSystem, finderGrid: PathFinderGrid): void {
    for (const link of system.links) {
      const subsystemA = this.gridSystems[link.a]!;
      const subsystemB = this.gridSystems[link.b]!;

      // Allowed systems to be traversed by the path from A to B. Part I.
      //
      // The path from A to B may need to traverse whiteboxes.
      // Here we say that only certain whiteboxes can be traversed.
      //
      // For example, for the path A.X to B,
      // we don't want the path to go through A.Y.
      //
      // To deny traversing systems, we momentarily close their ports.
      //
      const allowedSystems: string[] = [link.a, link.b];

      let parent: RuntimeSystem | RuntimeSubsystem | undefined =
        link.systemA.parent;

      while (parent?.id) {
        allowedSystems.push(parent.id);

        parent = parent.parent;
      }

      parent = link.systemB.parent;

      while (parent?.id) {
        allowedSystems.push(parent.id);

        parent = parent.parent;
      }

      for (const gridSS of Object.values(this.gridSystems)) {
        if (!allowedSystems.includes(gridSS.id)) {
          for (const port of gridSS.ports) {
            finderGrid.setWeightAt(port.x, port.y, Infinity);
          }
        }
      }

      // Find available ports.
      const subsystemAPorts = subsystemA.ports.filter(
        port =>
          this.grid[port.x]?.[port.y]?.at(-1)?.type ===
          SimulatorObjectType.Port,
      );

      const subsystemBPorts = subsystemB.ports.filter(
        port =>
          this.grid[port.x]?.[port.y]?.at(-1)?.type ===
          SimulatorObjectType.Port,
      );

      const candidates = subsystemAPorts
        .flatMap(portA =>
          subsystemBPorts.map(portB => ({
            portA,
            portB,
            distance: Math.sqrt(
              Math.pow(portB.x - portA.x, 2) + Math.pow(portB.y - portA.y, 2),
            ),
          })),
        )
        .sort((a, b) => a.distance - b.distance);

      for (const { portA, portB } of candidates) {
        finderGrid.reset();

        const route = findPath(portA.x, portA.y, portB.x, portB.y, finderGrid);

        if (route.length) {
          this.routes[link.a] ??= {};
          this.routes[link.a]![link.b] = route;

          this.routes[link.b] ??= {};
          this.routes[link.b]![link.a] = route.slice().reverse();

          const simulatorLinkHorizontal: SimulatorLink = Object.freeze({
            type: SimulatorObjectType.Link,
            direction: SimulatorLinkDirectionType.Horizontal,
            link,
          });

          const simulatorLinkVertical: SimulatorLink = Object.freeze({
            type: SimulatorObjectType.Link,
            direction: SimulatorLinkDirectionType.Vertical,
            link,
          });

          const simulatorLinkBottomToRight: SimulatorLink = Object.freeze({
            type: SimulatorObjectType.Link,
            direction: SimulatorLinkDirectionType.BottomToRight,
            link,
          });

          const simulatorLinkBottomToLeft: SimulatorLink = Object.freeze({
            type: SimulatorObjectType.Link,
            direction: SimulatorLinkDirectionType.BottomToLeft,
            link,
          });

          const simulatorLinkTopToLeft: SimulatorLink = Object.freeze({
            type: SimulatorObjectType.Link,
            direction: SimulatorLinkDirectionType.TopToLeft,
            link,
          });

          const simulatorLinkTopToRight: SimulatorLink = Object.freeze({
            type: SimulatorObjectType.Link,
            direction: SimulatorLinkDirectionType.TopToRight,
            link,
          });

          for (let i = 0; i < route.length; i++) {
            const [x, y] = route[i]!;

            // A path is still considered walkable but it has a higher cost
            // than an empty tile. It enables tunnels.
            finderGrid.setWeightAt(x!, y!, 2);

            const blackbox = this.grid[x!]![y!]!.find(
              obj => "blackbox" in obj && obj.blackbox,
            );

            // The link part is inside a blackbox.
            if (blackbox) {
              // this.grid[x!]![y!]!.push(blackbox);
              continue;
            }

            let xBefore: number;
            let yBefore: number;
            let xAfter: number;
            let yAfter: number;

            // There is no before / after.
            if (route.length === 1) {
              xBefore = portA.x;
              yBefore = portA.y;

              xAfter = portB.x;
              yAfter = portB.y;

              // There is no before.
            } else if (i === 0) {
              if (portA.x < subsystemA.x1) {
                xBefore = portA.x + 1;
                yBefore = portA.y;
              } else if (portA.x > subsystemA.x2) {
                xBefore = portA.x - 1;
                yBefore = portA.y;
              } else if (portA.y < subsystemA.y1) {
                xBefore = portA.x;
                yBefore = portA.y + 1;
              } else {
                xBefore = portA.x;
                yBefore = portA.y - 1;
              }

              xAfter = route[i + 1]![0]!;
              yAfter = route[i + 1]![1]!;

              // There is no after.
            } else if (i === route.length - 1) {
              xBefore = route[i - 1]![0]!;
              yBefore = route[i - 1]![1]!;

              if (portB.x < subsystemB.x1) {
                xAfter = portB.x + 1;
                yAfter = portB.y;
              } else if (portB.x > subsystemB.x2) {
                xAfter = portB.x - 1;
                yAfter = portB.y;
              } else if (portB.y < subsystemB.y1) {
                xAfter = portB.x;
                yAfter = portB.y + 1;
              } else {
                xAfter = portB.x;
                yAfter = portB.y - 1;
              }

              // There is a before / after.
            } else {
              xBefore = route[i - 1]![0]!;
              yBefore = route[i - 1]![1]!;

              xAfter = route[i + 1]![0]!;
              yAfter = route[i + 1]![1]!;
            }

            // ...    ...
            // BxA or AxB
            // ...    ...
            if (yBefore === y && yAfter === y) {
              this.grid[x!]![y!]!.push(simulatorLinkHorizontal);

              // .B.    .A.
              // .x. or .x.
              // .A.    .B.
            } else if (xBefore === x && xAfter === x) {
              this.grid[x!]![y!]!.push(simulatorLinkVertical);

              // ...    ...
              // .xA or .xB
              // .B.    .A.
            } else if (
              (xBefore === x && yBefore > y! && xAfter > x! && yAfter === y) ||
              (yBefore === y && xBefore > x! && yAfter > y! && xAfter === x)
            ) {
              this.grid[x!]![y!]!.push(simulatorLinkBottomToRight);

              // ...    ...
              // .Bx or .Ax
              // ..A    ..B
            } else if (
              (xBefore < x! && yBefore === y && xAfter === x && yAfter > y!) ||
              (yBefore > y! && xBefore === x && yAfter === y && xAfter < x!)
            ) {
              this.grid[x!]![y!]!.push(simulatorLinkBottomToLeft);

              // ...    ...
              // ..B or ..A
              // .Ax    .Bx
            } else if (
              (xBefore === x && yBefore < y! && xAfter < x! && yAfter === y) ||
              (yBefore === y && xBefore < x! && yAfter < y! && xAfter === x)
            ) {
              this.grid[x!]![y!]!.push(simulatorLinkTopToLeft);

              // ...    ...
              // .A. or .B.
              // .xB    .xA
            } else if (
              (xBefore > x! && yBefore === y && xAfter === x && yAfter < y!) ||
              (yBefore < y! && xBefore === x && yAfter === y && xAfter > x!)
            ) {
              this.grid[x!]![y!]!.push(simulatorLinkTopToRight);
            }
          }

          break;
        }
      }

      // Allowed systems to be traversed by the path from A to B. Part II.
      //
      // After a path from A to B is found (or not), we re-open the closed
      // ports of denied systems.
      for (const gridSS of Object.values(this.gridSystems)) {
        if (!allowedSystems.includes(gridSS.id)) {
          for (const port of gridSS.ports) {
            finderGrid.setWeightAt(port.x, port.y, 1);
          }
        }
      }
    }
  }

  private synchronizeRuntimeObjects(
    system: RuntimeSystem | RuntimeSubsystem,
  ): void {
    // Recursive traversal.
    for (const ss of system.systems) {
      const gridSS = this.gridSystems[ss.id]!;

      // Synchronize grid object with runtime system.
      // TODO: is it really how we want to tackle this?
      // TODO: or should a runtime system has a "grid" property, alike "specification".
      // TODO: so for a propertu, we would have the "spec" -> "runtime" -> "grid" transformations.
      ss.position.x = gridSS.worldX;
      ss.position.y = gridSS.worldY;

      ss.size.width = gridSS.width;
      ss.size.height = gridSS.height;

      this.synchronizeRuntimeObjects(ss);
    }
  }
}
