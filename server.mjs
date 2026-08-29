import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';

const services = [
  { id: 'manicure-classic', name: 'Классический маникюр', category: 'маникюр', price_kzt: 8000, duration_min: 60 },
  { id: 'manicure-gel', name: 'Маникюр с гель-лаком', category: 'маникюр', price_kzt: 12000, duration_min: 90 },
  { id: 'pedicure-classic', name: 'Классический педикюр', category: 'педикюр', price_kzt: 10000, duration_min: 75 },
  { id: 'pedicure-gel', name: 'Педикюр с гель-лаком', category: 'педикюр', price_kzt: 14500, duration_min: 100 },
  { id: 'nail-design', name: 'Дизайн ногтей', category: 'дизайн', price_kzt: 2500, duration_min: 30 }
];

const products = [
  { id: 'lak-red-01', name: 'Красный гель-лак Ruby 01', category: 'гель-лак', price_kzt: 4500, stock: 7 },
  { id: 'lak-red-02', name: 'Красный гель-лак Cherry 07', category: 'гель-лак', price_kzt: 3900, stock: 3 },
  { id: 'base-strong-01', name: 'Укрепляющая база Strong Base', category: 'база', price_kzt: 5200, stock: 5 },
  { id: 'cream-hand-01', name: 'Крем для рук Silk Hands', category: 'уход', price_kzt: 3200, stock: 11 },
  { id: 'oil-cuticle-01', name: 'Масло для кутикулы Almond Care', category: 'уход', price_kzt: 2800, stock: 0 }
];

const defaultSlots = ['10:00', '12:30', '15:00', '18:00', '19:30'];
const bookings = [];

function textResult(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj
  };
}

function normalize(s = '') {
  return s.toString().trim().toLowerCase();
}

function createServer() {
  const server = new McpServer({ name: 'yeti-nail-studio-demo', version: '1.0.0' });

  server.registerTool(
    'get_services',
    {
      description: 'Get salon services, prices in KZT, and duration. Use this when the user asks what services are available or how much a service costs.',
      inputSchema: z.object({
        category: z.string().optional().describe('Optional category such as маникюр, педикюр, дизайн')
      })
    },
    async ({ category }) => {
      const q = normalize(category);
      const list = q ? services.filter(s => normalize(s.category).includes(q) || normalize(s.name).includes(q)) : services;
      return textResult({ currency: 'KZT', services: list });
    }
  );

  server.registerTool(
    'check_available_slots',
    {
      description: 'Check available appointment times for a requested date. Use before creating a booking.',
      inputSchema: z.object({
        date: z.string().describe('Appointment date in YYYY-MM-DD format'),
        service_id: z.string().optional().describe('Optional service id'),
        time_of_day: z.enum(['morning', 'afternoon', 'evening']).optional().describe('Optional preferred part of day')
      })
    },
    async ({ date, service_id, time_of_day }) => {
      let slots = defaultSlots.filter(time => !bookings.some(b => b.date === date && b.time === time && b.status === 'confirmed'));
      if (time_of_day === 'morning') slots = slots.filter(t => t < '12:00');
      if (time_of_day === 'afternoon') slots = slots.filter(t => t >= '12:00' && t < '18:00');
      if (time_of_day === 'evening') slots = slots.filter(t => t >= '18:00');
      return textResult({ date, service_id: service_id ?? null, available_slots: slots });
    }
  );

  server.registerTool(
    'create_booking',
    {
      description: 'Create a salon appointment only after the user has clearly confirmed the service, date, time, and customer name. Returns a booking confirmation id.',
      inputSchema: z.object({
        customer_name: z.string().min(1).describe('Customer name'),
        service_id: z.string().min(1).describe('Service id from get_services'),
        date: z.string().describe('Appointment date in YYYY-MM-DD format'),
        time: z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/).describe('Appointment time in HH:MM format')
      })
    },
    async ({ customer_name, service_id, date, time }) => {
      const service = services.find(s => s.id === service_id);
      if (!service) {
        return { content: [{ type: 'text', text: 'Unknown service_id. Call get_services first.' }], isError: true };
      }
      if (!defaultSlots.includes(time)) {
        return { content: [{ type: 'text', text: `Time ${time} is not an offered slot.` }], isError: true };
      }
      const occupied = bookings.some(b => b.date === date && b.time === time && b.status === 'confirmed');
      if (occupied) {
        return { content: [{ type: 'text', text: `Slot ${date} ${time} is no longer available. Call check_available_slots again.` }], isError: true };
      }
      const booking = {
        booking_id: `BK-${randomUUID().slice(0, 8).toUpperCase()}`,
        customer_name,
        service_id,
        service_name: service.name,
        date,
        time,
        price_kzt: service.price_kzt,
        status: 'confirmed',
        created_at: new Date().toISOString()
      };
      bookings.push(booking);
      return textResult(booking);
    }
  );

  server.registerTool(
    'search_products',
    {
      description: 'Search salon retail products by name or category and optionally by maximum price. Use for product recommendations and cheaper alternatives.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Product name, color, or category, for example красный лак or крем'),
        max_price_kzt: z.number().positive().optional().describe('Optional maximum price in KZT')
      })
    },
    async ({ query, max_price_kzt }) => {
      const q = normalize(query);
      let list = products.filter(p => normalize(`${p.name} ${p.category}`).includes(q));
      if (list.length === 0) {
        const terms = q.split(/\s+/).filter(Boolean);
        list = products.filter(p => terms.some(term => normalize(`${p.name} ${p.category}`).includes(term)));
      }
      if (max_price_kzt !== undefined) list = list.filter(p => p.price_kzt <= max_price_kzt);
      return textResult({ currency: 'KZT', products: list });
    }
  );

  server.registerTool(
    'check_product_stock',
    {
      description: 'Check the current price and stock quantity for one salon retail product.',
      inputSchema: z.object({
        product_id: z.string().min(1).describe('Product id from search_products')
      })
    },
    async ({ product_id }) => {
      const product = products.find(p => p.id === product_id);
      if (!product) {
        return { content: [{ type: 'text', text: 'Unknown product_id. Call search_products first.' }], isError: true };
      }
      return textResult({ ...product, in_stock: product.stock > 0, currency: 'KZT' });
    }
  );

  return server;
}

const handler = createMcpHandler(() => createServer());
const nodeHandler = toNodeHandler(handler);

const host = '0.0.0.0';
const allowedHosts = ['localhost', '127.0.0.1'];
if (process.env.RENDER_EXTERNAL_HOSTNAME) allowedHosts.push(process.env.RENDER_EXTERNAL_HOSTNAME);

const app = createMcpFastifyApp({ host, allowedHosts });

app.get('/', async () => ({
  ok: true,
  service: 'Yeti Nail Studio MCP Demo',
  mcp_endpoint: '/mcp',
  demo_bookings: '/bookings'
}));

app.get('/bookings', async () => ({
  warning: 'Demo memory storage: data resets when the server restarts or sleeps.',
  bookings
}));

app.all('/mcp', async (request, reply) => nodeHandler(request.raw, reply.raw, request.body));

const port = Number(process.env.PORT || 3000);
await app.listen({ port, host });
console.log(`Yeti Nail Studio MCP running on port ${port}`);
