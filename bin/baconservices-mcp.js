#!/usr/bin/env node
// stdio entry point. stdout carries the MCP protocol only; nothing else is ever written there.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBaconServer } from '../src/server.js';

const { server } = createBaconServer();
await server.connect(new StdioServerTransport());
