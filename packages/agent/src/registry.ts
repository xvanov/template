/**
 * The tools agents (and MCP clients, for proposals) can use. Add yours here.
 * Names are unique and match TOOL_NAME; the unit tests check both.
 */
import type { AgentTool, ReadTool, WriteTool } from "./tool";
import { docsSearch } from "./tools/docs"; // @module:rag
import { itemsCreate, itemsDelete, itemsSearch } from "./tools/items";

export const TOOLS: readonly AgentTool[] = [
  itemsSearch,
  docsSearch, // @module:rag
  itemsCreate,
  itemsDelete,
];

export function toolByName(name: string): AgentTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function writeTool(name: string): WriteTool | undefined {
  const t = toolByName(name);
  return t?.effect === "write" ? t : undefined;
}

export function readTool(name: string): ReadTool | undefined {
  const t = toolByName(name);
  return t?.effect === "read" ? t : undefined;
}
