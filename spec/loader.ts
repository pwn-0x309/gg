import { load as parseYaml } from "js-yaml";
import { RuntimeSystem, RuntimeSubsystem, RuntimeLink } from "./runtime.js";
import { System } from "./specification.js";
import { validate, ValidationError } from "./validations.js";
import { computeSystemPorts, computeSystemSize, initSystem } from "./system.js";

export function load(system: System): {
  system: RuntimeSystem;
  errors: ValidationError[];
} {
  const runtime = structuredClone(system) as RuntimeSystem;

  runtime.specification = system;
  runtime.links ??= [];
  runtime.titlePosition = { x: 0, y: 0 };
  runtime.titleSize = { width: 0, height: 0 };
  runtime.size = { width: 0, height: 0 };
  runtime.depth = 0;
  runtime.position = { x: 0, y: 0 };

  // TODO: we are enhancing a system that wasn't validated with AJV yet,
  // TODO: so it's the far west in the JSON file.
  // TODO: validate with AJV first, then enhance if possible.

  enhanceSubsystems(runtime);
  enhanceLinks(runtime);
  enhanceFlows(runtime);
  computeSizes(runtime, runtime.links);
  computePorts(runtime);

  const errors = validate(system, runtime);

  return { system: runtime, errors };
}

export function loadYaml(yaml: string): {
  system: RuntimeSystem;
  errors: ValidationError[];
} {
  return load(parseYaml(yaml) as System);
}

function enhanceSubsystems(
  system: RuntimeSystem | RuntimeSubsystem,
  depth = 1,
): void {
  system.systems ??= [];

  for (const [index, subsystem] of system.systems.entries()) {
    initSystem(
      subsystem,
      system,
      system.specification.systems!.at(index)!,
      index,
      depth,
    );

    // Enhance recursively.
    enhanceSubsystems(subsystem, depth + 1);
  }
}

function enhanceLinks(system: RuntimeSystem): void {
  for (const [index, link] of system.links.entries()) {
    // Set the specification.
    link.specification = system.specification.links!.at(index)!;

    // Set array position in the system.
    link.index = index;

    // Set system A.
    let systemA: RuntimeSubsystem | RuntimeSystem | undefined = system;

    for (const subsystemId of link.a.split(".")) {
      if (systemA) {
        systemA = systemA.systems.find(ss => ss.id === subsystemId);
      }
    }

    link.systemA = systemA as unknown as RuntimeSubsystem;

    // Set system B.
    let systemB: RuntimeSubsystem | RuntimeSystem | undefined = system;

    for (const subsystemId of link.b.split(".")) {
      if (systemB) {
        systemB = systemB.systems.find(ss => ss.id === subsystemId);
      }
    }

    link.systemB = systemB as unknown as RuntimeSubsystem;
  }
}

function enhanceFlows(system: RuntimeSystem): void {
  system.flows ??= [];

  for (const [index, flow] of system.flows.entries()) {
    // Set the specification.
    flow.specification = system.specification.flows!.at(index)!;

    // Set array position.
    flow.index = index;

    // Normalize keyframes.
    // TODO: put in "normalizedKeyframe" so errors are reported on "keyframe".
    const uniqueKeyframes = new Set<number>();

    for (const step of flow.steps) {
      uniqueKeyframes.add(step.keyframe);
    }

    const keyframes = Array.from(uniqueKeyframes).sort();

    for (const [index, step] of flow.steps.entries()) {
      // Set the specification.
      step.specification = flow.specification.steps.at(index)!;

      // Set normalized keyframe.
      step.keyframe = keyframes.indexOf(step.keyframe);

      // Set systemFrom.
      let systemFrom: RuntimeSystem | RuntimeSubsystem | undefined = system;

      for (const subsystemId of step.from.split(".")) {
        systemFrom = systemFrom.systems.find(ss => ss.id === subsystemId);

        if (!systemFrom) {
          break;
        }
      }

      step.systemFrom = systemFrom as RuntimeSubsystem;

      // Set systemTo.
      let systemTo: RuntimeSystem | RuntimeSubsystem | undefined = system;

      for (const subsystemId of step.to.split(".")) {
        systemTo = systemTo.systems.find(ss => ss.id === subsystemId);

        if (!systemTo) {
          break;
        }
      }

      step.systemTo = systemTo as RuntimeSubsystem;

      // Set links.
      step.links ??= [];

      if (step.systemFrom && step.systemTo) {
        step.links = findLinks(system.links, step.from, step.to);
      }
    }
  }
}

function findLinks(
  links: RuntimeLink[],
  from: string,
  to: string,
): RuntimeLink[] {
  const systemNameToNumber = new Map<string, number>();

  let nextNumber = 0;

  for (const link of links) {
    if (!systemNameToNumber.has(link.a)) {
      systemNameToNumber.set(link.a, nextNumber);
      nextNumber += 1;
    }

    if (!systemNameToNumber.has(link.b)) {
      systemNameToNumber.set(link.b, nextNumber);
      nextNumber += 1;
    }
  }

  if (
    systemNameToNumber.get(from) === undefined ||
    systemNameToNumber.get(to) === undefined
  ) {
    return [];
  }

  const numberToSystemName = new Array(systemNameToNumber.size);

  for (const [subsystemName, index] of systemNameToNumber.entries()) {
    numberToSystemName[index] = subsystemName;
  }

  const graph = new Array<number[]>(systemNameToNumber.size);

  for (let i = 0; i < systemNameToNumber.size; i++) {
    graph[i] = [];
  }

  for (const link of links) {
    graph[systemNameToNumber.get(link.a)!]!.push(
      systemNameToNumber.get(link.b)!,
    );
    graph[systemNameToNumber.get(link.b)!]!.push(
      systemNameToNumber.get(link.a)!,
    );
  }

  const breadcrumbs = Array<number>(systemNameToNumber.size).fill(-1);
  const distances = Array<number>(systemNameToNumber.size).fill(Infinity);
  const queue = [systemNameToNumber.get(from)!];

  distances[systemNameToNumber.get(from)!] = 0;

  while (queue.length) {
    const node = queue.shift()!;

    for (const neighbor of graph[node]!) {
      if (distances[neighbor] === Infinity) {
        breadcrumbs[neighbor] = node;
        distances[neighbor] = distances[node]! + 1;

        queue.push(neighbor);
      }
    }
  }

  if (distances[systemNameToNumber.get(to)!] === Infinity) {
    return [];
  }

  const pathIndexes = [systemNameToNumber.get(to)!];

  let currentNode = systemNameToNumber.get(to)!;

  while (breadcrumbs[currentNode] !== -1) {
    pathIndexes.push(breadcrumbs[currentNode]!);

    currentNode = breadcrumbs[currentNode]!;
  }

  const pathSystems = pathIndexes
    .reverse()
    .map(index => numberToSystemName[index]);

  const pathLinks: RuntimeLink[] = [];

  for (let i = 0; i < pathSystems.length - 1; i++) {
    const link = links.find(
      l =>
        (l.a === pathSystems[i] && l.b === pathSystems[i + 1]) ||
        (l.b === pathSystems[i] && l.a === pathSystems[i + 1]),
    )!;

    pathLinks.push(link);
  }

  return pathLinks;
}

function computeSizes(
  system: RuntimeSystem | RuntimeSubsystem,
  links: RuntimeLink[],
): void {
  // Recursive traversal.
  for (const subsystem of system.systems) {
    computeSizes(subsystem, links);
  }

  // Root system.
  if (!system.canonicalId) {
    return;
  }

  computeSystemSize(system, links);
}

function computePorts(system: RuntimeSystem | RuntimeSubsystem) {
  for (const subsystem of system.systems) {
    computeSystemPorts(subsystem);

    // Recursive traversal.
    computePorts(subsystem);
  }
}
