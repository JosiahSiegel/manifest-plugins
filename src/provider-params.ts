/**
 * Structural mirror of the provider-parameter surface exported by upstream
 * `mnfst/manifest`. This package builds before the upstream checkout exists,
 * so plugin contracts must not import the private upstream shared workspace.
 */

export type AuthType = 'api_key' | 'subscription' | 'local';

export type ModelCapability =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'stream'
  | 'tools';

export type ModelParamType =
  | 'boolean'
  | 'enum'
  | 'integer'
  | 'number'
  | 'string';

export type ModelParamGroup =
  | 'generation_length'
  | 'sampling'
  | 'reasoning'
  | 'tooling'
  | 'output_format'
  | 'observability'
  | 'provider_metadata';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ModelParamRange {
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface ParamApplicabilityCondition {
  readonly not: JsonPrimitive | readonly JsonPrimitive[];
}

export type ParamApplicabilityValue =
  | JsonPrimitive
  | readonly JsonPrimitive[]
  | ParamApplicabilityCondition;
export type ParamApplicabilityMatch = Readonly<
  Record<string, ParamApplicabilityValue>
>;
export type ParamApplicabilityRule =
  | ParamApplicabilityMatch
  | readonly ParamApplicabilityMatch[];

export interface ParamApplicability {
  readonly only?: ParamApplicabilityRule;
  readonly except?: ParamApplicabilityRule;
}

export interface ModelParamDefinition {
  readonly path: string;
  readonly type: ModelParamType;
  readonly label: string;
  readonly description: string;
  readonly default?: JsonValue;
  readonly values?: readonly JsonValue[];
  readonly range?: ModelParamRange;
  readonly group: ModelParamGroup;
  readonly applicability?: ParamApplicability;
}

export interface ProviderParamSpec extends ModelParamDefinition {
  readonly provider: string;
  readonly authType: AuthType;
  readonly model: string;
}

export function providerParamValueIsValid(
  spec: ModelParamDefinition,
  value: unknown,
): boolean {
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return (spec.values ?? []).some((candidate) =>
        jsonValuesEqual(value, candidate),
      );
    case 'integer':
      return numberValueIsValid(spec, value, Number.isInteger);
    case 'number':
      return numberValueIsValid(spec, value);
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

function numberValueIsValid(
  spec: ModelParamDefinition,
  value: unknown,
  predicate: (value: number) => boolean = Number.isFinite,
): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value) || !predicate(value)) {
    return false;
  }
  if (spec.range?.min !== undefined && value < spec.range.min) return false;
  if (spec.range?.max !== undefined && value > spec.range.max) return false;
  return true;
}

function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (
    (typeof a === 'object' && a !== null) ||
    (typeof b === 'object' && b !== null)
  ) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}
