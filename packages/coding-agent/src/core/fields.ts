/**
 * Extension-owned fields: values other code may read, keyed by extension namespace, name, and
 * version so extensions do not collide. Pi stores them and never interprets them.
 */
import type { JsonValue } from "@earendil-works/pi-ai";

/** Key of an extension-owned field: "<namespace>/<name>@<version>". */
export type FieldKey = string;

/** Identity of an extension-owned field; see `pi.registerField()`. */
export interface FieldSpec {
	/** Owner of the field, such as the extension's name. */
	namespace: string;
	name: string;
	/** Bumped when the value's shape changes; entries written under the old key keep it. */
	version: number;
}

/** An entry or message that can carry extension-owned fields. */
export interface FieldHolder {
	fields?: Record<FieldKey, JsonValue>;
}

export function fieldKey(spec: FieldSpec): FieldKey {
	return `${spec.namespace}/${spec.name}@${spec.version}`;
}

/** Read one extension-owned field of an entry or message. */
export function getField<T extends JsonValue>(holder: FieldHolder, key: FieldKey): T | undefined {
	return holder.fields?.[key] as T | undefined;
}

/** Keys of the fields present on an entry or message, all of them or those of one namespace. */
export function listFields(holder: FieldHolder, namespace?: string): FieldKey[] {
	const keys = Object.keys(holder.fields ?? {});
	return namespace === undefined ? keys : keys.filter((key) => key.startsWith(`${namespace}/`));
}

/** Session files are parsed without validation: only a plain object counts as a `fields` record. */
export function isFieldRecord(value: unknown): value is Record<FieldKey, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
