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
const BUSINESS_TIME_ZONE = 'Asia/Almaty';

function textResult(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj
  };
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true
  };
}

function normalize(s = '') {
  return s.toString().trim().toLowerCase();
}

function getBusinessDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  const baseUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day)
  );

  return new Date(
    baseUtc + offsetDays * 86400000
  ).toISOString().slice(0, 10);
}

function resolveBookingDate(date_type, exact_date) {
  if (date_type === 'today') {
    return getBusinessDate(0);
  }

  if (date_type === 'tomorrow') {
    return getBusinessDate(1);
  }

  if (
    date_type === 'exact' &&
    exact_date &&
    /^\d{4}-\d{2}-\d{2}$/.test(exact_date)
  ) {
    return exact_date;
  }

  return null;
}

function findBookingById(booking_id) {
  return bookings.find(
    b => b.booking_id === booking_id
  );
}

function isSlotOccupied(
  date,
  time,
  excludeBookingId = null
) {
  return bookings.some(
    b =>
      b.booking_id !== excludeBookingId &&
      b.date === date &&
      b.time === time &&
      b.status === 'confirmed'
  );
}

function findConfirmedBookingsByCustomer(customer_name) {
  const q = normalize(customer_name);

  return bookings.filter(
    b =>
      normalize(b.customer_name) === q &&
      b.status === 'confirmed'
  );
}

function resolveTargetBooking(
  booking_id,
  customer_name
) {
  if (booking_id) {
    const booking = findBookingById(booking_id);

    if (!booking) {
      return {
        error: 'Unknown booking_id.'
      };
    }

    return { booking };
  }

  if (!customer_name) {
    return {
      error: 'Provide booking_id or customer_name.'
    };
  }

  const matches =
    findConfirmedBookingsByCustomer(
      customer_name
    );

  if (matches.length === 0) {
    return {
      error:
        `No confirmed booking found for ${customer_name}.`
    };
  }

  if (matches.length > 1) {
    return {
      error:
        `More than one confirmed booking found for ${customer_name}. ` +
        'Call get_customer_bookings first and use booking_id.'
    };
  }

  return {
    booking: matches[0]
  };
}

function createServer() {
  const server = new McpServer({
    name: 'yeti-nail-studio-demo',
    version: '1.3.0'
  });

  server.registerTool(
    'get_services',
    {
      description:
        'Get salon services, prices in KZT, and duration. Use this when the user asks what services are available or how much a service costs.',

      inputSchema: z.object({
        category: z
          .string()
          .optional()
          .describe(
            'Optional category such as маникюр, педикюр, дизайн'
          )
      })
    },

    async ({ category }) => {
      const q = normalize(category);

      const list = q
        ? services.filter(
            s =>
              normalize(s.category).includes(q) ||
              normalize(s.name).includes(q)
          )
        : services;

      return textResult({
        currency: 'KZT',
        services: list
      });
    }
  );

  server.registerTool(
    'check_available_slots',
    {
      description:
        'Check available appointment times for a requested date. Use before creating or rescheduling a booking. For relative dates, pass today or tomorrow instead of calculating the calendar date yourself.',

      inputSchema: z.object({
        date_type: z
          .enum([
            'today',
            'tomorrow',
            'exact'
          ])
          .describe(
            'Use today for сегодня, tomorrow for завтра, and exact only when the user explicitly gives a calendar date.'
          ),

        exact_date: z
          .string()
          .optional()
          .describe(
            'YYYY-MM-DD only when date_type is exact. Leave empty for today or tomorrow.'
          ),

        service_id: z
          .string()
          .optional()
          .describe(
            'Optional service id from get_services'
          ),

        time_of_day: z
          .enum([
            'morning',
            'afternoon',
            'evening'
          ])
          .optional()
          .describe(
            'Optional preferred part of day'
          )
      })
    },

    async ({
      service_id,
      date_type,
      exact_date,
      time_of_day
    }) => {
      const date = resolveBookingDate(
        date_type,
        exact_date
      );

      if (!date) {
        return errorResult(
          'Invalid appointment date. Use today, tomorrow, or an explicit YYYY-MM-DD date.'
        );
      }

      let slots = defaultSlots.filter(
        time =>
          !isSlotOccupied(
            date,
            time
          )
      );

      if (time_of_day === 'morning') {
        slots = slots.filter(
          t => t < '12:00'
        );
      }

      if (time_of_day === 'afternoon') {
        slots = slots.filter(
          t =>
            t >= '12:00' &&
            t < '18:00'
        );
      }

      if (time_of_day === 'evening') {
        slots = slots.filter(
          t => t >= '18:00'
        );
      }

      return textResult({
        date,
        service_id:
          service_id ?? null,
        available_slots: slots
      });
    }
  );

  server.registerTool(
    'create_booking',
    {
      description:
        'Create a NEW salon appointment only after the user has clearly confirmed service, date, time, and customer name. Do NOT use this tool to move, change, reschedule, or cancel an existing booking. For a change use get_customer_bookings then reschedule_booking. For cancellation use get_customer_bookings then cancel_booking. For relative dates, pass today or tomorrow and do not calculate the calendar date yourself. Return success only when the booking is actually created.',

      inputSchema: z.object({
        customer_name: z
          .string()
          .min(1)
          .describe(
            'Customer name exactly as the user provided it'
          ),

        service_id: z
          .string()
          .min(1)
          .describe(
            'Service id from get_services'
          ),

        date_type: z
          .enum([
            'today',
            'tomorrow',
            'exact'
          ])
          .describe(
            'Use today for сегодня, tomorrow for завтра, and exact only when the user explicitly gives a calendar date.'
          ),

        exact_date: z
          .string()
          .optional()
          .describe(
            'YYYY-MM-DD only when date_type is exact. Leave empty for today or tomorrow.'
          ),

        time: z
          .string()
          .regex(
            /^([01]\d|2[0-3]):[0-5]\d$/
          )
          .describe(
            'Appointment time in HH:MM format'
          )
      })
    },

    async ({
      customer_name,
      service_id,
      date_type,
      exact_date,
      time
    }) => {
      const date = resolveBookingDate(
        date_type,
        exact_date
      );

      if (!date) {
        return errorResult(
          'Invalid appointment date. Use today, tomorrow, or an explicit YYYY-MM-DD date.'
        );
      }

      const service = services.find(
        s => s.id === service_id
      );

      if (!service) {
        return errorResult(
          'Unknown service_id. Call get_services first.'
        );
      }

      if (
        !defaultSlots.includes(time)
      ) {
        return errorResult(
          `Time ${time} is not an offered slot.`
        );
      }

      if (
        isSlotOccupied(
          date,
          time
        )
      ) {
        return errorResult(
          `Slot ${date} ${time} is no longer available. Call check_available_slots again.`
        );
      }

      const booking = {
        booking_id:
          `BK-${randomUUID()
            .slice(0, 8)
            .toUpperCase()}`,

        customer_name,
        service_id,
        service_name:
          service.name,
        date,
        time,
        price_kzt:
          service.price_kzt,
        status: 'confirmed',

        created_at:
          new Date().toISOString(),

        updated_at: null,
        cancelled_at: null
      };

      bookings.push(booking);

      return textResult(
        booking
      );
    }
  );

  server.registerTool(
    'get_customer_bookings',
    {
      description:
        'Find existing salon bookings for a customer. Use this BEFORE rescheduling or cancelling when the user refers to my booking, my appointment, move my appointment, change the time, or cancel my appointment. Use the returned booking_id with reschedule_booking or cancel_booking.',

      inputSchema: z.object({
        customer_name: z
          .string()
          .min(1)
          .describe(
            'Customer name exactly as known from the conversation'
          ),

        status: z
          .enum([
            'confirmed',
            'cancelled',
            'all'
          ])
          .optional()
          .describe(
            'Default confirmed. Use all only when history is needed.'
          )
      })
    },

    async ({
      customer_name,
      status = 'confirmed'
    }) => {
      const q =
        normalize(
          customer_name
        );

      let list =
        bookings.filter(
          b =>
            normalize(
              b.customer_name
            ) === q
        );

      if (
        status !== 'all'
      ) {
        list = list.filter(
          b =>
            b.status === status
        );
      }

      return textResult({
        customer_name,
        bookings: list
      });
    }
  );

  server.registerTool(
    'reschedule_booking',
    {
      description:
        'Move an EXISTING confirmed booking to a new date and/or time while keeping the same booking_id. Use this for ONE reschedule action. If the user asks for TWO OR MORE dependent booking changes in the same message, use process_booking_changes instead.',

      inputSchema: z.object({
        booking_id: z
          .string()
          .min(1)
          .describe(
            'Existing booking id returned by get_customer_bookings'
          ),

        new_date_type: z
          .enum([
            'today',
            'tomorrow',
            'exact'
          ])
          .describe(
            'Use today for сегодня, tomorrow for завтра, and exact only when the user explicitly gives a calendar date.'
          ),

        new_exact_date: z
          .string()
          .optional()
          .describe(
            'YYYY-MM-DD only when new_date_type is exact. Leave empty for today or tomorrow.'
          ),

        new_time: z
          .string()
          .regex(
            /^([01]\d|2[0-3]):[0-5]\d$/
          )
          .describe(
            'New appointment time in HH:MM format'
          )
      })
    },

    async ({
      booking_id,
      new_date_type,
      new_exact_date,
      new_time
    }) => {
      const booking =
        findBookingById(
          booking_id
        );

      if (!booking) {
        return errorResult(
          'Unknown booking_id. Call get_customer_bookings first.'
        );
      }

      if (
        booking.status !==
        'confirmed'
      ) {
        return errorResult(
          `Booking ${booking_id} is not active and cannot be rescheduled.`
        );
      }

      const newDate =
        resolveBookingDate(
          new_date_type,
          new_exact_date
        );

      if (!newDate) {
        return errorResult(
          'Invalid new appointment date. Use today, tomorrow, or an explicit YYYY-MM-DD date.'
        );
      }

      if (
        !defaultSlots.includes(
          new_time
        )
      ) {
        return errorResult(
          `Time ${new_time} is not an offered slot.`
        );
      }

      if (
        isSlotOccupied(
          newDate,
          new_time,
          booking_id
        )
      ) {
        return errorResult(
          `Slot ${newDate} ${new_time} is already occupied. Call check_available_slots again.`
        );
      }

      const previous = {
        date: booking.date,
        time: booking.time
      };

      booking.date =
        newDate;

      booking.time =
        new_time;

      booking.updated_at =
        new Date()
          .toISOString();

      return textResult({
        action:
          'rescheduled',
        previous,
        booking
      });
    }
  );

  server.registerTool(
    'cancel_booking',
    {
      description:
        'Cancel an EXISTING confirmed salon booking. Use this for ONE cancellation action. Always use get_customer_bookings first to obtain the correct booking_id when needed. If the user asks for TWO OR MORE dependent booking changes in the same message, use process_booking_changes instead.',

      inputSchema: z.object({
        booking_id: z
          .string()
          .min(1)
          .describe(
            'Existing booking id returned by get_customer_bookings'
          )
      })
    },

    async ({
      booking_id
    }) => {
      const booking =
        findBookingById(
          booking_id
        );

      if (!booking) {
        return errorResult(
          'Unknown booking_id. Call get_customer_bookings first.'
        );
      }

      if (
        booking.status ===
        'cancelled'
      ) {
        return errorResult(
          `Booking ${booking_id} is already cancelled.`
        );
      }

      booking.status =
        'cancelled';

      booking.cancelled_at =
        new Date()
          .toISOString();

      booking.updated_at =
        booking.cancelled_at;

      return textResult({
        action:
          'cancelled',
        booking
      });
    }
  );

  server.registerTool(
    'process_booking_changes',
    {
      description:
        'Execute TWO OR MORE dependent changes to the SAME existing booking in the exact order requested by the user, inside one reliable server-side workflow. Example: reschedule the booking to 15:00 and then cancel it. Use this instead of separate reschedule_booking/cancel_booking calls when multiple dependent changes are requested in ONE user message. The server executes actions sequentially and stops if a step fails.',

      inputSchema: z.object({
        booking_id: z
          .string()
          .optional()
          .describe(
            'Existing booking id if known. Prefer this when available.'
          ),

        customer_name: z
          .string()
          .optional()
          .describe(
            'Customer name. Used to locate the booking when booking_id is not known. This works automatically only when the customer has exactly one confirmed booking.'
          ),

        actions: z
          .array(
            z.enum([
              'reschedule',
              'cancel'
            ])
          )
          .min(2)
          .max(4)
          .describe(
            'Ordered list of actions exactly as requested by the user. Example: ["reschedule", "cancel"].'
          ),

        new_date_type: z
          .enum([
            'today',
            'tomorrow',
            'exact'
          ])
          .optional()
          .describe(
            'Required when actions contains reschedule. Use today, tomorrow, or exact.'
          ),

        new_exact_date: z
          .string()
          .optional()
          .describe(
            'YYYY-MM-DD only when new_date_type is exact.'
          ),

        new_time: z
          .string()
          .regex(
            /^([01]\d|2[0-3]):[0-5]\d$/
          )
          .optional()
          .describe(
            'Required when actions contains reschedule. New time in HH:MM format.'
          )
      })
    },

    async ({
      booking_id,
      customer_name,
      actions,
      new_date_type,
      new_exact_date,
      new_time
    }) => {
      const target =
        resolveTargetBooking(
          booking_id,
          customer_name
        );

      if (
        target.error
      ) {
        return errorResult(
          target.error
        );
      }

      const booking =
        target.booking;

      if (
        booking.status !==
        'confirmed'
      ) {
        return errorResult(
          `Booking ${booking.booking_id} is not active.`
        );
      }

      const steps = [];

      for (
        const action of actions
      ) {
        if (
          action ===
          'reschedule'
        ) {
          if (
            !new_date_type ||
            !new_time
          ) {
            return errorResult(
              'Reschedule step requires new_date_type and new_time.'
            );
          }

          const newDate =
            resolveBookingDate(
              new_date_type,
              new_exact_date
            );

          if (!newDate) {
            return errorResult(
              'Invalid new appointment date for reschedule step.'
            );
          }

          if (
            !defaultSlots.includes(
              new_time
            )
          ) {
            return errorResult(
              `Time ${new_time} is not an offered slot.`
            );
          }

          if (
            isSlotOccupied(
              newDate,
              new_time,
              booking.booking_id
            )
          ) {
            return errorResult(
              `Slot ${newDate} ${new_time} is already occupied.`
            );
          }

          const previous = {
            date:
              booking.date,

            time:
              booking.time
          };

          booking.date =
            newDate;

          booking.time =
            new_time;

          booking.updated_at =
            new Date()
              .toISOString();

          steps.push({
            action:
              'rescheduled',

            previous,

            current: {
              date:
                booking.date,

              time:
                booking.time
            }
          });

          continue;
        }

        if (
          action ===
          'cancel'
        ) {
          if (
            booking.status !==
            'confirmed'
          ) {
            return errorResult(
              `Booking ${booking.booking_id} is already cancelled.`
            );
          }

          booking.status =
            'cancelled';

          booking.cancelled_at =
            new Date()
              .toISOString();

          booking.updated_at =
            booking.cancelled_at;

          steps.push({
            action:
              'cancelled'
          });
        }
      }

      return textResult({
        action:
          'workflow_completed',

        steps,
        booking
      });
    }
  );

  server.registerTool(
    'search_products',
    {
      description:
        'Search salon retail products by name or category and optionally by maximum price. Use for product recommendations and cheaper alternatives.',

      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Product name, color, or category, for example красный лак or крем'
          ),

        max_price_kzt: z
          .number()
          .positive()
          .optional()
          .describe(
            'Optional maximum price in KZT'
          )
      })
    },

    async ({
      query,
      max_price_kzt
    }) => {
      const q =
        normalize(query);

      let list =
        products.filter(
          p =>
            normalize(
              `${p.name} ${p.category}`
            ).includes(q)
        );

      if (
        list.length === 0
      ) {
        const terms =
          q
            .split(/\s+/)
            .filter(Boolean);

        list =
          products.filter(
            p =>
              terms.some(
                term =>
                  normalize(
                    `${p.name} ${p.category}`
                  ).includes(
                    term
                  )
              )
          );
      }

      if (
        max_price_kzt !==
        undefined
      ) {
        list =
          list.filter(
            p =>
              p.price_kzt <=
              max_price_kzt
          );
      }

      return textResult({
        currency:
          'KZT',
        products:
          list
      });
    }
  );

  server.registerTool(
    'check_product_stock',
    {
      description:
        'Check the current price and stock quantity for one salon retail product.',

      inputSchema: z.object({
        product_id: z
          .string()
          .min(1)
          .describe(
            'Product id from search_products'
          )
      })
    },

    async ({
      product_id
    }) => {
      const product =
        products.find(
          p =>
            p.id ===
            product_id
        );

      if (!product) {
        return errorResult(
          'Unknown product_id. Call search_products first.'
        );
      }

      return textResult({
        ...product,
        in_stock:
          product.stock > 0,
        currency:
          'KZT'
      });
    }
  );

  return server;
}

const handler =
  createMcpHandler(
    () => createServer()
  );

const nodeHandler =
  toNodeHandler(
    handler
  );

const host =
  '0.0.0.0';

const allowedHosts = [
  'localhost',
  '127.0.0.1'
];

if (
  process.env
    .RENDER_EXTERNAL_HOSTNAME
) {
  allowedHosts.push(
    process.env
      .RENDER_EXTERNAL_HOSTNAME
  );
}

const app =
  createMcpFastifyApp({
    host,
    allowedHosts
  });

app.get(
  '/',
  async () => ({
    ok: true,
    service:
      'Yeti Nail Studio MCP Demo',
    version:
      '1.3.0',
    mcp_endpoint:
      '/mcp',
    demo_bookings:
      '/bookings'
  })
);

app.get(
  '/bookings',
  async () => ({
    warning:
      'Demo memory storage: data resets when the server restarts or sleeps.',
    bookings
  })
);

app.all(
  '/mcp',
  async (
    request,
    reply
  ) =>
    nodeHandler(
      request.raw,
      reply.raw,
      request.body
    )
);

const port =
  Number(
    process.env.PORT ||
      3000
  );

await app.listen({
  port,
  host
});

console.log(
  `Yeti Nail Studio MCP running on port ${port}`
);
