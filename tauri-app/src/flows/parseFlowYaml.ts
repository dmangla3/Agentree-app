import { parse } from 'yaml';

export function parseFlowYaml(source: string): unknown {
  return parse(source);
}
