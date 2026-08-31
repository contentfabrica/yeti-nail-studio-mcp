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

const uiState = {
  event_seq: 0,
  last_action: 'idle',
  last_action_at: null,
  focus: null,
  selected_date: null,
  selected_service_id: null,
  selected_time: null,
  touched_booking_id: null,
  product_ids: [],
  service_ids: []
};

const uiEvents = [];

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

function normalize(value = '') {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[-–—]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function markUi(action, focus, payload = {}) {
  uiState.event_seq += 1;
  uiState.last_action = action;
  uiState.last_action_at = new Date().toISOString();
  uiState.focus = focus ?? null;

  if (focus !== 'products') uiState.product_ids = [];
  if (focus !== 'services') uiState.service_ids = [];

  if (payload.selected_date !== undefined) uiState.selected_date = payload.selected_date;
  if (payload.selected_service_id !== undefined) uiState.selected_service_id = payload.selected_service_id;
  if (payload.selected_time !== undefined) uiState.selected_time = payload.selected_time;
  if (payload.touched_booking_id !== undefined) uiState.touched_booking_id = payload.touched_booking_id;
  if (payload.product_ids !== undefined) uiState.product_ids = payload.product_ids;
  if (payload.service_ids !== undefined) uiState.service_ids = payload.service_ids;

  uiEvents.push({
    seq: uiState.event_seq,
    action,
    focus: uiState.focus,
    at: uiState.last_action_at,
    payload: { ...payload }
  });

  if (uiEvents.length > 25) uiEvents.shift();
}

const QUERY_STOP_WORDS = new Set([
  'а','и','или','ну','тогда','пожалуйста','сейчас','какие','какой','какая','какое','что','есть','ли','у','вас','мне','меня',
  'покажи','показать','подскажи','расскажи','сколько','стоит','цена','цены','по','на','в','из','для','все','весь','вся',
  'услуги','услуга','товары','товар','продукты','продукт','каталог','ассортимент','доступно','доступны','имеются','наличие',
  'наличии','остаток','остатки','осталось','штук','шт','дешевле','дороже','самый','самая','самое','вариант','варианты','можно',
  'купить','хочу','запиши','записать','запись','сделать','приду','приеду'
]);

function meaningfulQueryTerms(value) {
  return normalize(value)
    .split(/\s+/)
    .filter(Boolean)
    .filter(term => !QUERY_STOP_WORDS.has(term));
}

function isGenericServiceQuery(value) {
  return ['', 'все', 'услуги', 'все услуги', 'прайс', 'прайс лист', 'каталог', 'ассортимент'].includes(normalize(value));
}

function isGenericProductQuery(value) {
  return ['', 'все', 'товары', 'все товары', 'продукты', 'все продукты', 'каталог', 'ассортимент'].includes(normalize(value));
}

function resolveServiceReference(service_id, service_query, fallbackId = null) {
  if (service_id) {
    const byId = services.find(s => s.id === service_id);
    return byId
      ? { service: byId }
      : { error: 'Unknown service_id. Call get_services or provide service_query.' };
  }

  const q = normalize(service_query);

  if (!q && fallbackId) {
    const fallback = services.find(s => s.id === fallbackId);
    if (fallback) return { service: fallback };
  }

  if (!q) {
    return { error: 'Provide service_id or service_query.' };
  }

  let matches = services.filter(
    s =>
      normalize(s.name) === q ||
      normalize(s.id) === q
  );

  if (matches.length === 1) {
    return { service: matches[0] };
  }

  matches = services.filter(
    s =>
      normalize(s.name).includes(q) ||
      normalize(s.category).includes(q)
  );

  if (matches.length === 1) {
    return { service: matches[0] };
  }

  const terms = meaningfulQueryTerms(service_query);

  matches = services.filter(s => {
    const hay = normalize(s.name + ' ' + s.category);
    return terms.every(term => hay.includes(term));
  });

  if (matches.length === 1) {
    return { service: matches[0] };
  }

  if (matches.length > 1) {
    return {
      error:
        'Service request is ambiguous. Matches: ' +
        matches
          .map(s => s.name + ' (' + s.id + ')')
          .join(', ')
    };
  }

  return {
    error: 'No service matched "' + service_query + '".'
  };
}

function resolveProductReference(product_id, product_query) {
  if (product_id) {
    const byId = products.find(p => p.id === product_id);

    return byId
      ? { product: byId }
      : { error: 'Unknown product_id. Call search_products or provide product_query.' };
  }

  const q = normalize(product_query);

  if (!q) {
    return { error: 'Provide product_id or product_query.' };
  }

  let matches = products.filter(
    p =>
      normalize(p.name) === q ||
      normalize(p.id) === q
  );

  if (matches.length === 1) {
    return { product: matches[0] };
  }

  matches = products.filter(
    p => normalize(p.name).includes(q)
  );

  if (matches.length === 1) {
    return { product: matches[0] };
  }

  const terms = meaningfulQueryTerms(product_query);

  matches = products.filter(p => {
    const hay = normalize(p.name + ' ' + p.category);
    return terms.every(term => hay.includes(term));
  });

  if (matches.length === 1) {
    return { product: matches[0] };
  }

  if (matches.length > 1) {
    return {
      error:
        'Product request is ambiguous. Matches: ' +
        matches
          .map(p => p.name + ' (' + p.id + ')')
          .join(', ')
    };
  }

  return {
    error: 'No product matched "' + product_query + '".'
  };
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
  if (date_type === 'today') return getBusinessDate(0);
  if (date_type === 'tomorrow') return getBusinessDate(1);

  if (
    date_type === 'exact' &&
    exact_date &&
    /^\d{4}-\d{2}-\d{2}$/.test(exact_date)
  ) {
    return exact_date;
  }

  return null;
}

function resolveBookingDateWithFallback(
  date_type,
  exact_date,
  fallbackDate = null
) {
  if (date_type) {
    return resolveBookingDate(date_type, exact_date);
  }

  if (
    fallbackDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(fallbackDate)
  ) {
    return fallbackDate;
  }

  return null;
}

function findBookingById(booking_id) {
  return bookings.find(
    b => b.booking_id === booking_id
  );
}

function isSlotOccupied(date, time, excludeBookingId = null) {
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

function resolveTargetBooking(booking_id, customer_name) {
  if (booking_id) {
    const booking = findBookingById(booking_id);

    return booking
      ? { booking }
      : { error: 'Unknown booking_id.' };
  }

  if (!customer_name) {
    return {
      error: 'Provide booking_id or customer_name.'
    };
  }

  const matches =
    findConfirmedBookingsByCustomer(customer_name);

  if (matches.length === 0) {
    return {
      error:
        'No confirmed booking found for ' +
        customer_name +
        '.'
    };
  }

  if (matches.length > 1) {
    return {
      error:
        'More than one confirmed booking found for ' +
        customer_name +
        '. Call get_customer_bookings first and use booking_id.'
    };
  }

  return {
    booking: matches[0]
  };
}

function latestBookingFirst(list) {
  return [...list].sort((a, b) => {
    const ta = new Date(
      a.updated_at ||
      a.cancelled_at ||
      a.created_at ||
      0
    ).getTime();

    const tb = new Date(
      b.updated_at ||
      b.cancelled_at ||
      b.created_at ||
      0
    ).getTime();

    return tb - ta;
  });
}

function buildDemoData() {
  const displayDate =
    uiState.selected_date ||
    getBusinessDate(1);

  const slots = defaultSlots.map(time => {
    const booking = bookings.find(
      b =>
        b.date === displayDate &&
        b.time === time &&
        b.status === 'confirmed'
    );

    return {
      time,
      occupied: Boolean(booking),
      customer_name:
        booking?.customer_name ?? null,
      booking_id:
        booking?.booking_id ?? null
    };
  });

  return {
    service: 'Yeti Nail Studio',
    timezone: BUSINESS_TIME_ZONE,
    generated_at: new Date().toISOString(),
    display_date: displayDate,
    services,
    slots,
    bookings:
      latestBookingFirst(bookings),
    products,
    ui: { ...uiState }
  };
}

function createServer() {
  const server = new McpServer({
    name: 'yeti-nail-studio-demo',
    version: '1.6.0'
  });

  server.registerTool(
    'get_services',
    {
      description:
        'ALWAYS call this tool for questions about salon services, service names, categories, prices, durations, manicure, pedicure, nail design, or what services are offered. Use query for a specific service or category. Leave query empty for the full service list. Never answer service catalog or current price questions from memory when this tool is available.',

      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            'Optional service name or category, for example классический маникюр, маникюр, педикюр, дизайн. Leave empty for all services.'
          ),

        category: z
          .string()
          .optional()
          .describe(
            'Legacy optional category. Prefer query. Kept for compatibility.'
          )
      })
    },

    async ({ query, category }) => {
      const raw =
        query ??
        category ??
        '';

      const q =
        normalize(raw);

      const terms =
        meaningfulQueryTerms(raw);

      let list;

      if (
        isGenericServiceQuery(raw) ||
        terms.length === 0
      ) {
        list = services;
      } else {
        list = services.filter(
          s =>
            normalize(s.name).includes(q) ||
            normalize(s.category).includes(q)
        );

        if (list.length === 0) {
          list = services.filter(
            s => {
              const hay =
                normalize(
                  s.name +
                  ' ' +
                  s.category
                );

              return terms.every(
                term =>
                  hay.includes(term)
              );
            }
          );
        }
      }

      markUi(
        'services_loaded',
        'services',
        {
          service_ids:
            list.map(
              s => s.id
            ),

          selected_service_id:
            list.length === 1
              ? list[0].id
              : null
        }
      );

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
        'Use this tool when the user asks which appointment times are free, available, or asks you to suggest a time. Do NOT call it again just before create_booking when the user has already selected an exact slot; create_booking performs its own final availability check. Relative dates should use today or tomorrow. The tool can also remember the selected service and date for the next booking turn.',

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
            'Optional service id from get_services.'
          ),

        service_query: z
          .string()
          .optional()
          .describe(
            'Optional natural service name such as классический маникюр or классический педикюр when service_id is not known.'
          ),

        time_of_day: z
          .enum([
            'morning',
            'afternoon',
            'evening'
          ])
          .optional()
          .describe(
            'Optional preferred part of day.'
          )
      })
    },

    async ({
      service_id,
      service_query,
      date_type,
      exact_date,
      time_of_day
    }) => {
      const date =
        resolveBookingDate(
          date_type,
          exact_date
        );

      if (!date) {
        return errorResult(
          'Invalid appointment date. Use today, tomorrow, or an explicit YYYY-MM-DD date.'
        );
      }

      let selectedService = null;

      if (
        service_id ||
        service_query
      ) {
        const resolvedService =
          resolveServiceReference(
            service_id,
            service_query
          );

        if (resolvedService.error) {
          return errorResult(
            resolvedService.error
          );
        }

        selectedService =
          resolvedService.service;
      }

      let slots =
        defaultSlots.filter(
          time =>
            !isSlotOccupied(
              date,
              time
            )
        );

      if (
        time_of_day ===
        'morning'
      ) {
        slots = slots.filter(
          t => t < '12:00'
        );
      }

      if (
        time_of_day ===
        'afternoon'
      ) {
        slots = slots.filter(
          t =>
            t >= '12:00' &&
            t < '18:00'
        );
      }

      if (
        time_of_day ===
        'evening'
      ) {
        slots = slots.filter(
          t => t >= '18:00'
        );
      }

      markUi(
        'slots_checked',
        'slots',
        {
          selected_date:
            date,

          selected_service_id:
            selectedService?.id ??
            uiState.selected_service_id,

          service_ids:
            selectedService
              ? [selectedService.id]
              : []
        }
      );

      return textResult({
        date,

        service:
          selectedService
            ? {
                id:
                  selectedService.id,

                name:
                  selectedService.name
              }
            : null,

        available_slots:
          slots
      });
    }
  );

  server.registerTool(
    'create_booking',
    {
      description:
        'ALWAYS call this tool when the user clearly asks to book or make a NEW appointment and customer name, service, date, and time are known either from the current message or from the immediately preceding booking conversation. Reuse the date/service just selected in the previous availability turn instead of forcing the user to repeat them. Do NOT call check_available_slots again when an exact slot was already chosen; this tool performs its own final slot validation. Do not use for moving or cancelling an existing booking.',

      inputSchema: z.object({
        customer_name: z
          .string()
          .min(1)
          .describe(
            'Customer name exactly as the user provided it or as already known in the current conversation.'
          ),

        service_id: z
          .string()
          .optional()
          .describe(
            'Optional service id from get_services. If omitted, use service_query or the service selected in the immediately preceding turn.'
          ),

        service_query: z
          .string()
          .optional()
          .describe(
            'Optional natural service name such as классический маникюр or классический педикюр when service_id is not known.'
          ),

        date_type: z
          .enum([
            'today',
            'tomorrow',
            'exact'
          ])
          .optional()
          .describe(
            'Use today for сегодня, tomorrow for завтра, exact for an explicit date. May be omitted only when continuing immediately from a check_available_slots result; the server will reuse that selected date.'
          ),

        exact_date: z
          .string()
          .optional()
          .describe(
            'YYYY-MM-DD only when date_type is exact.'
          ),

        time: z
          .string()
          .regex(
            /^([01]\d|2[0-3]):[0-5]\d$/
          )
          .describe(
            'Appointment time in HH:MM format.'
          )
      })
    },

    async ({
      customer_name,
      service_id,
      service_query,
      date_type,
      exact_date,
      time
    }) => {
      const date =
        resolveBookingDateWithFallback(
          date_type,
          exact_date,
          uiState.selected_date
        );

      if (!date) {
        return errorResult(
          'Appointment date is missing. Provide today, tomorrow, an exact date, or check available slots first.'
        );
      }

      const resolvedService =
        resolveServiceReference(
          service_id,
          service_query,
          uiState.selected_service_id
        );

      if (resolvedService.error) {
        return errorResult(
          resolvedService.error
        );
      }

      const service =
        resolvedService.service;

      if (
        !defaultSlots.includes(time)
      ) {
        return errorResult(
          'Time ' +
          time +
          ' is not an offered slot.'
        );
      }

      if (
        isSlotOccupied(
          date,
          time
        )
      ) {
        return errorResult(
          'Slot ' +
          date +
          ' ' +
          time +
          ' is no longer available. Choose another available slot.'
        );
      }

      const booking = {
        booking_id:
          'BK-' +
          randomUUID()
            .slice(0, 8)
            .toUpperCase(),

        customer_name,

        service_id:
          service.id,

        service_name:
          service.name,

        date,
        time,

        price_kzt:
          service.price_kzt,

        status:
          'confirmed',

        created_at:
          new Date()
            .toISOString(),

        updated_at:
          null,

        cancelled_at:
          null
      };

      bookings.push(
        booking
      );

      markUi(
        'booking_created',
        'booking',
        {
          selected_date:
            date,

          selected_service_id:
            service.id,

          selected_time:
            time,

          service_ids:
            [service.id],

          touched_booking_id:
            booking.booking_id
        }
      );

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
        list =
          list.filter(
            b =>
              b.status ===
              status
          );
      }

      const first =
        latestBookingFirst(
          list
        )[0] ?? null;

      markUi(
        'booking_checked',
        'booking',
        {
          selected_date:
            first?.date ??
            uiState.selected_date,

          selected_service_id:
            first?.service_id ??
            uiState.selected_service_id,

          selected_time:
            first?.time ??
            uiState.selected_time,

          service_ids:
            first?.service_id
              ? [first.service_id]
              : [],

          touched_booking_id:
            first?.booking_id ??
            null
        }
      );

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
        'Move an EXISTING confirmed booking to a new date and/or time while keeping the same booking_id. ALWAYS use this when the user says move, change, reschedule, switch the time/date, or changed their mind about an existing appointment. Reuse the date from the immediately preceding availability check if new_date_type is omitted. Do not create a second booking. If the user asks for TWO OR MORE dependent booking changes in the same message, use process_booking_changes instead.',

      inputSchema: z.object({
        booking_id: z
          .string()
          .min(1)
          .describe(
            'Existing booking id returned by get_customer_bookings.'
          ),

        new_date_type: z
          .enum([
            'today',
            'tomorrow',
            'exact'
          ])
          .optional()
          .describe(
            'Use today for сегодня, tomorrow for завтра, exact for an explicit date. May be omitted only when immediately reusing the date from check_available_slots.'
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
          .describe(
            'New appointment time in HH:MM format.'
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
          'Booking ' +
          booking_id +
          ' is not active and cannot be rescheduled.'
        );
      }

      const newDate =
        resolveBookingDateWithFallback(
          new_date_type,
          new_exact_date,
          uiState.selected_date
        );

      if (!newDate) {
        return errorResult(
          'New appointment date is missing. Provide today, tomorrow, an exact date, or check available slots first.'
        );
      }

      if (
        !defaultSlots.includes(
          new_time
        )
      ) {
        return errorResult(
          'Time ' +
          new_time +
          ' is not an offered slot.'
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
          'Slot ' +
          newDate +
          ' ' +
          new_time +
          ' is already occupied. Choose another available slot.'
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

      markUi(
        'booking_rescheduled',
        'booking',
        {
          selected_date:
            newDate,

          selected_service_id:
            booking.service_id,

          selected_time:
            new_time,

          service_ids:
            [booking.service_id],

          touched_booking_id:
            booking.booking_id
        }
      );

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
        'Cancel an EXISTING confirmed salon booking. ALWAYS use this when the user clearly asks to cancel or remove an existing appointment. Use get_customer_bookings first only when the correct booking_id is not already known. If the user asks for TWO OR MORE dependent booking changes in the same message, use process_booking_changes instead.',

      inputSchema: z.object({
        booking_id: z
          .string()
          .min(1)
          .describe(
            'Existing booking id returned by get_customer_bookings.'
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
          'Booking ' +
          booking_id +
          ' is already cancelled.'
        );
      }

      booking.status =
        'cancelled';

      booking.cancelled_at =
        new Date()
          .toISOString();

      booking.updated_at =
        booking.cancelled_at;

      markUi(
        'booking_cancelled',
        'booking',
        {
          selected_date:
            booking.date,

          selected_service_id:
            booking.service_id,

          selected_time:
            booking.time,

          service_ids:
            [booking.service_id],

          touched_booking_id:
            booking.booking_id
        }
      );

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
        'Execute TWO OR MORE dependent changes to the SAME existing booking in the exact order requested by the user, inside one server-side workflow. Example: reschedule to 15:00 and then cancel. Use this instead of separate reschedule_booking/cancel_booking calls when multiple dependent changes are requested in ONE user message. The server executes actions sequentially and stops if a step fails.',

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
            'Used when actions contains reschedule. May be omitted only when immediately reusing a date from check_available_slots.'
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
          'Booking ' +
          booking.booking_id +
          ' is not active.'
        );
      }

      const steps = [];

      for (
        const action
        of actions
      ) {
        if (
          action ===
          'reschedule'
        ) {
          if (
            booking.status !==
            'confirmed'
          ) {
            return errorResult(
              'Booking ' +
              booking.booking_id +
              ' is not active and cannot be rescheduled.'
            );
          }

          if (!new_time) {
            return errorResult(
              'Reschedule step requires new_time.'
            );
          }

          const newDate =
            resolveBookingDateWithFallback(
              new_date_type,
              new_exact_date,
              uiState.selected_date
            );

          if (!newDate) {
            return errorResult(
              'Reschedule date is missing. Provide today, tomorrow, an exact date, or check available slots first.'
            );
          }

          if (
            !defaultSlots.includes(
              new_time
            )
          ) {
            return errorResult(
              'Time ' +
              new_time +
              ' is not an offered slot.'
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
              'Slot ' +
              newDate +
              ' ' +
              new_time +
              ' is already occupied.'
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
              'Booking ' +
              booking.booking_id +
              ' is already cancelled.'
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

      markUi(
        'booking_workflow_completed',
        'booking',
        {
          selected_date:
            booking.date,

          selected_service_id:
            booking.service_id,

          selected_time:
            booking.time,

          service_ids:
            [booking.service_id],

          touched_booking_id:
            booking.booking_id
        }
      );

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
        'ALWAYS call this tool for questions about salon retail products, product names, categories, colors, prices, recommendations, cheaper alternatives, or what products are available. Leave query empty for the full catalog. For a specific stock question, check_product_stock may be used directly with product_query. Do not answer current product catalog or price questions from memory when this tool is available.',

      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            'Optional product name, color, or category, for example красный лак, Ruby, крем. Leave empty for all products.'
          ),

        max_price_kzt: z
          .number()
          .positive()
          .optional()
          .describe(
            'Optional maximum price in KZT.'
          )
      })
    },

    async ({
      query,
      max_price_kzt
    }) => {
      const q =
        normalize(query);

      const terms =
        meaningfulQueryTerms(query);

      let list;

      if (
        isGenericProductQuery(query) ||
        terms.length === 0
      ) {
        list = products;
      } else {
        list =
          products.filter(
            p =>
              normalize(
                p.name +
                ' ' +
                p.category
              ).includes(q)
          );

        if (
          list.length === 0
        ) {
          list =
            products.filter(
              p => {
                const hay =
                  normalize(
                    p.name +
                    ' ' +
                    p.category
                  );

                return terms.every(
                  term =>
                    hay.includes(term)
                );
              }
            );
        }
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

      markUi(
        'products_found',
        'products',
        {
          product_ids:
            list.map(
              p => p.id
            )
        }
      );

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
        'ALWAYS call this tool when the user asks whether a specific salon product is in stock, available, sold out, how many units remain, or asks for the current stock of a specific product. You may pass either product_id or a natural product_query such as Ruby, Cherry, Almond Care, красный гель лак. Do not require a separate search_products call first when the product can be identified directly.',

      inputSchema: z.object({
        product_id: z
          .string()
          .optional()
          .describe(
            'Optional product id from search_products.'
          ),

        product_query: z
          .string()
          .optional()
          .describe(
            'Optional natural product name or query when product_id is not known, for example Ruby, Almond Care, укрепляющая база.'
          )
      })
    },

    async ({
      product_id,
      product_query
    }) => {
      const resolved =
        resolveProductReference(
          product_id,
          product_query
        );

      if (
        resolved.error
      ) {
        return errorResult(
          resolved.error
        );
      }

      const product =
        resolved.product;

      markUi(
        'product_stock_checked',
        'products',
        {
          product_ids:
            [product.id]
        }
      );

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

const DEMO_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yeti Nail Studio — Live Demo</title>

<style>
:root{
  --bg:#070812;
  --panel:#111323;
  --line:rgba(255,255,255,.09);
  --text:#f6f7fb;
  --muted:#9ea4bb;
  --pink:#ff4f9d;
  --purple:#8f63ff;
  --green:#70f28c;
  --red:#ff6a74;
}

*{
  box-sizing:border-box;
}

html,
body{
  margin:0;
  width:100%;
  min-height:100%;

  background:
    radial-gradient(
      circle at 20% 0%,
      rgba(143,99,255,.16),
      transparent 36%
    ),
    radial-gradient(
      circle at 100% 18%,
      rgba(255,79,157,.12),
      transparent 32%
    ),
    var(--bg);

  color:
    var(--text);

  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

body{
  padding:22px;
}

.shell{
  max-width:1540px;
  margin:0 auto;
}

.topbar{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:16px;
  margin-bottom:18px;
}

.brand{
  display:flex;
  align-items:center;
  gap:14px;
}

.brand-mark{
  width:48px;
  height:48px;
  border-radius:15px;
  display:grid;
  place-items:center;
  font-size:25px;

  background:
    linear-gradient(
      145deg,
      rgba(255,79,157,.28),
      rgba(143,99,255,.28)
    );

  border:
    1px solid
    rgba(255,255,255,.12);

  box-shadow:
    0 10px 34px
    rgba(143,99,255,.18);
}

.brand h1{
  margin:0;
  font-size:26px;
  letter-spacing:.03em;
}

.brand p{
  margin:4px 0 0;
  color:var(--pink);
  font-size:12px;
  letter-spacing:.16em;
  text-transform:uppercase;
  font-weight:800;
}

.live{
  display:inline-flex;
  align-items:center;
  gap:9px;
  padding:11px 16px;
  border-radius:999px;

  background:
    rgba(255,255,255,.045);

  border:
    1px solid
    var(--line);

  color:#e8eaf4;
  font-size:13px;
  font-weight:800;
}

.live-dot{
  width:9px;
  height:9px;
  border-radius:50%;
  background:var(--green);

  box-shadow:
    0 0 15px
    rgba(112,242,140,.8);
}

.grid{
  display:grid;

  grid-template-columns:
    1.05fr
    1.3fr
    1.05fr;

  gap:16px;
  align-items:stretch;
}

.stack{
  display:grid;
  gap:16px;
}

.panel{
  background:
    linear-gradient(
      180deg,
      rgba(23,24,43,.95),
      rgba(14,16,30,.96)
    );

  border:
    1px solid
    var(--line);

  border-radius:22px;
  padding:18px;

  box-shadow:
    0 18px 55px
    rgba(0,0,0,.25);

  transition:
    transform .22s ease,
    border-color .22s ease,
    box-shadow .22s ease;
}

.panel.glow{
  border-color:
    rgba(255,79,157,.98);

  box-shadow:
    0 0 0 2px rgba(255,79,157,.34),
    0 0 34px rgba(255,79,157,.58),
    0 0 78px rgba(143,99,255,.32),
    0 18px 55px rgba(0,0,0,.32);

  transform:
    translateY(-2px)
    scale(1.006);

  animation:
    panelPulse
    1.05s
    ease-in-out
    2;
}

@keyframes panelPulse{
  0%,
  100%{
    filter:
      brightness(1);
  }

  50%{
    filter:
      brightness(1.24);
  }
}

.panel-title{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
  margin-bottom:14px;
}

.panel-title h2{
  margin:0;
  font-size:15px;
  letter-spacing:.02em;
}

.date-chip{
  color:#c7cbe0;
  font-size:12px;
  padding:7px 10px;
  border-radius:10px;
  border:1px solid var(--line);
  background:rgba(255,255,255,.035);

  transition:
    color .2s ease,
    background .2s ease,
    border-color .2s ease,
    box-shadow .2s ease,
    transform .2s ease;
}

.date-chip.date-flash{
  color:#fff;

  background:
    linear-gradient(
      135deg,
      rgba(255,79,157,.42),
      rgba(143,99,255,.42)
    );

  border-color:
    rgba(255,126,190,.98);

  box-shadow:
    0 0 0 2px rgba(255,79,157,.28),
    0 0 30px rgba(255,79,157,.78),
    0 0 58px rgba(143,99,255,.50);

  transform:
    scale(1.10);

  animation:
    datePulse
    .85s
    ease-in-out
    3;
}

@keyframes datePulse{
  0%,
  100%{
    filter:
      brightness(1);
  }

  50%{
    filter:
      brightness(1.42);
  }
}

.list{
  display:grid;
  gap:9px;
}

.service,
.product{
  display:grid;

  grid-template-columns:
    42px
    1fr
    auto;

  gap:12px;
  align-items:center;
  padding:12px;
  border-radius:15px;

  background:
    rgba(255,255,255,.035);

  border:
    1px solid
    rgba(255,255,255,.065);

  transition:
    border-color .22s ease,
    background .22s ease,
    box-shadow .22s ease,
    transform .22s ease;
}

.product.highlight{
  border-color:
    rgba(255,79,157,.98);

  background:
    rgba(255,79,157,.14);

  box-shadow:
    0 0 0 1px rgba(255,79,157,.24),
    0 0 30px rgba(255,79,157,.46);

  transform:
    translateX(-3px)
    scale(1.012);
}

.service.highlight{
  border-color:
    rgba(255,79,157,.98);

  background:
    linear-gradient(
      135deg,
      rgba(255,79,157,.16),
      rgba(143,99,255,.12)
    );

  box-shadow:
    0 0 0 1px rgba(255,79,157,.28),
    0 0 28px rgba(255,79,157,.52),
    0 0 52px rgba(143,99,255,.28);

  transform:
    translateX(3px)
    scale(1.015);

  animation:
    servicePulse
    .85s
    ease-in-out
    3;
}

@keyframes servicePulse{
  0%,
  100%{
    filter:
      brightness(1);
  }

  50%{
    filter:
      brightness(1.28);
  }
}

.icon{
  width:42px;
  height:42px;
  border-radius:13px;
  display:grid;
  place-items:center;
  font-size:21px;

  background:
    linear-gradient(
      145deg,
      rgba(255,79,157,.16),
      rgba(143,99,255,.16)
    );
}

.name{
  font-weight:800;
  font-size:13px;
  line-height:1.25;
}

.meta{
  color:var(--muted);
  font-size:11px;
  margin-top:4px;
}

.price{
  color:#ff77b6;
  font-size:14px;
  font-weight:900;
  white-space:nowrap;
}

.slots{
  display:grid;

  grid-template-columns:
    repeat(
      5,
      minmax(0,1fr)
    );

  gap:10px;
}

.slot{
  min-height:64px;
  border-radius:15px;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  gap:4px;

  border:
    1px solid
    rgba(255,255,255,.08);

  font-weight:900;
  font-size:17px;

  transition:
    all .2s ease;
}

.slot.free{
  color:#a7ffb7;

  background:
    rgba(41,181,75,.15);

  border-color:
    rgba(112,242,140,.24);
}

.slot.busy{
  color:#ff9da5;

  background:
    rgba(209,52,65,.15);

  border-color:
    rgba(255,106,116,.30);
}

.slot.changed{
  box-shadow:
    0 0 0 2px rgba(143,99,255,.30),
    0 0 30px rgba(143,99,255,.58);

  transform:
    scale(1.06);
}

.slot small{
  color:var(--muted);
  font-size:9px;
  font-weight:700;
  max-width:100%;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}

.booking-card{
  min-height:196px;
  display:flex;
  flex-direction:column;
  justify-content:center;
  gap:13px;
  padding:4px 2px;
}

.booking-empty{
  min-height:176px;

  border:
    1px dashed
    rgba(255,255,255,.12);

  border-radius:17px;
  display:grid;
  place-items:center;
  text-align:center;
  color:var(--muted);
  padding:24px;
}

.booking-person{
  display:flex;
  align-items:center;
  gap:13px;
}

.avatar{
  width:52px;
  height:52px;
  border-radius:16px;
  display:grid;
  place-items:center;
  font-size:24px;

  background:
    linear-gradient(
      145deg,
      rgba(143,99,255,.45),
      rgba(255,79,157,.25)
    );

  border:
    1px solid
    rgba(255,255,255,.12);
}

.booking-main{
  display:grid;

  grid-template-columns:
    1fr
    auto;

  gap:16px;
  align-items:end;
  padding-top:13px;

  border-top:
    1px solid
    var(--line);
}

.booking-service{
  font-size:18px;
  font-weight:900;
}

.booking-time{
  margin-top:7px;
  color:#d8dbee;
  font-size:13px;
}

.status{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-width:112px;
  padding:9px 11px;
  border-radius:999px;
  font-size:10px;
  font-weight:900;
  letter-spacing:.06em;
  text-transform:uppercase;
}

.status.confirmed{
  color:#bcffc8;

  background:
    rgba(41,181,75,.16);

  border:
    1px solid
    rgba(112,242,140,.22);
}

.status.cancelled{
  color:#ffc0c5;

  background:
    rgba(209,52,65,.16);

  border:
    1px solid
    rgba(255,106,116,.24);
}

.stock{
  margin-top:5px;
  display:inline-block;
  color:#c6ffd0;
  font-size:10px;
  font-weight:900;
  padding:4px 7px;
  border-radius:8px;

  background:
    rgba(41,181,75,.14);
}

.stock.out{
  color:#ffc0c5;

  background:
    rgba(209,52,65,.14);
}

.stock.stock-highlight{
  box-shadow:
    0 0 0 1px rgba(112,242,140,.28),
    0 0 22px rgba(112,242,140,.58);

  transform:
    scale(1.12);

  animation:
    stockPulse
    .8s
    ease-in-out
    3;
}

.stock.out.stock-highlight{
  box-shadow:
    0 0 0 1px rgba(255,106,116,.30),
    0 0 22px rgba(255,106,116,.62);
}

@keyframes stockPulse{
  0%,
  100%{
    filter:
      brightness(1);
  }

  50%{
    filter:
      brightness(1.45);
  }
}

.footer{
  margin-top:14px;
  display:flex;
  justify-content:space-between;
  gap:14px;
  color:#727991;
  font-size:10px;
}

@media(
  max-width:1120px
){
  .grid{
    grid-template-columns:
      1fr
      1fr;
  }

  .products-panel{
    grid-column:
      1 / -1;
  }

  .products-panel .list{
    grid-template-columns:
      repeat(
        2,
        minmax(0,1fr)
      );
  }
}

@media(
  max-width:760px
){
  body{
    padding:12px;
  }

  .topbar{
    align-items:flex-start;
  }

  .grid{
    grid-template-columns:1fr;
  }

  .products-panel{
    grid-column:auto;
  }

  .products-panel .list{
    grid-template-columns:1fr;
  }

  .slots{
    grid-template-columns:
      repeat(
        2,
        minmax(0,1fr)
      );
  }

  .brand h1{
    font-size:20px;
  }

  .live{
    font-size:11px;
    padding:9px 12px;
  }
}
</style>
</head>

<body>

<div class="shell">

  <div class="topbar">

    <div class="brand">

      <div class="brand-mark">
        💅
      </div>

      <div>

        <h1>
          YETI NAIL STUDIO
        </h1>

        <p>
          Live salon system
        </p>

      </div>

    </div>

    <div class="live">
      <span class="live-dot"></span>
      LIVE
    </div>

  </div>

  <div class="grid">

    <section
      id="servicesPanel"
      class="panel"
    >

      <div class="panel-title">
        <h2>
          УСЛУГИ
        </h2>
      </div>

      <div
        id="services"
        class="list"
      ></div>

    </section>

    <div class="stack">

      <section
        id="slotsPanel"
        class="panel"
      >

        <div class="panel-title">

          <h2>
            СВОБОДНЫЕ СЛОТЫ
          </h2>

          <div
            id="displayDate"
            class="date-chip"
          >
            —
          </div>

        </div>

        <div
          id="slots"
          class="slots"
        ></div>

      </section>

      <section
        id="bookingPanel"
        class="panel"
      >

        <div class="panel-title">

          <h2>
            ЗАПИСЬ КЛИЕНТА
          </h2>

        </div>

        <div
          id="booking"
        ></div>

      </section>

    </div>

    <section
      id="productsPanel"
      class="panel products-panel"
    >

      <div class="panel-title">

        <h2>
          ТОВАРЫ
        </h2>

      </div>

      <div
        id="products"
        class="list"
      ></div>

    </section>

  </div>

  <div class="footer">

    <span>
      Данные обновляются автоматически
    </span>

    <span id="updatedAt">
      —
    </span>

  </div>

</div>

<script>

function esc(value) {
  return String(value ?? '')
    .replaceAll(
      '&',
      '&amp;'
    )
    .replaceAll(
      '<',
      '&lt;'
    )
    .replaceAll(
      '>',
      '&gt;'
    )
    .replaceAll(
      '"',
      '&quot;'
    )
    .replaceAll(
      "'",
      '&#039;'
    );
}

function money(value) {
  return new Intl.NumberFormat(
    'ru-RU'
  ).format(
    value
  ) + ' ₸';
}

function serviceIcon(category) {
  if (
    category ===
    'педикюр'
  ) {
    return '🦶';
  }

  if (
    category ===
    'дизайн'
  ) {
    return '✨';
  }

  return '💅';
}

function productIcon(category) {
  if (
    category ===
    'уход'
  ) {
    return '🧴';
  }

  if (
    category ===
    'база'
  ) {
    return '◼';
  }

  return '💎';
}

function humanDate(value) {
  if (!value) {
    return '—';
  }

  const parts =
    value.split('-');

  if (
    parts.length !== 3
  ) {
    return value;
  }

  return (
    parts[2] +
    '.' +
    parts[1] +
    '.' +
    parts[0]
  );
}

const UI_FLASH_MS =
  7000;

const DATE_ACTIONS =
  new Set([
    'slots_checked',
    'booking_created',
    'booking_checked',
    'booking_rescheduled',
    'booking_cancelled',
    'booking_workflow_completed'
  ]);

const SLOT_ACTIONS =
  new Set([
    'booking_created',
    'booking_checked',
    'booking_rescheduled',
    'booking_cancelled',
    'booking_workflow_completed'
  ]);

let uiTrackerReady =
  false;

let lastUiEventSeq =
  0;

let uiFlashUntil =
  0;

let dateFlashUntil =
  0;

let previousDisplayDate =
  null;

let previousSlotState =
  new Map();

let slotFlashUntil =
  new Map();

function syncUiAction(ui) {
  const seq =
    Number(
      ui &&
      ui.event_seq
        ? ui.event_seq
        : 0
    );

  if (
    !uiTrackerReady
  ) {
    lastUiEventSeq =
      seq;

    uiTrackerReady =
      true;

    return;
  }

  if (
    seq ===
    lastUiEventSeq
  ) {
    return;
  }

  lastUiEventSeq =
    seq;

  const now =
    Date.now();

  uiFlashUntil =
    now +
    UI_FLASH_MS;

  if (
    ui &&
    ui.selected_date &&
    DATE_ACTIONS.has(
      ui.last_action
    )
  ) {
    dateFlashUntil =
      now +
      UI_FLASH_MS;
  }

  if (
    ui &&
    ui.selected_date &&
    ui.selected_time &&
    SLOT_ACTIONS.has(
      ui.last_action
    )
  ) {
    slotFlashUntil.set(
      ui.selected_date +
      '|' +
      ui.selected_time,

      now +
      UI_FLASH_MS
    );
  }
}

function actionIsFresh(ui) {
  return (
    Boolean(ui) &&
    Date.now() <
    uiFlashUntil
  );
}

function setGlow(ui) {
  [
    'servicesPanel',
    'slotsPanel',
    'bookingPanel',
    'productsPanel'
  ].forEach(
    function(id) {
      document
        .getElementById(id)
        .classList
        .remove('glow');
    }
  );

  if (
    !actionIsFresh(ui) ||
    !ui.focus
  ) {
    return;
  }

  const map = {
    services:
      'servicesPanel',

    slots:
      'slotsPanel',

    booking:
      'bookingPanel',

    products:
      'productsPanel'
  };

  const id =
    map[ui.focus];

  if (id) {
    document
      .getElementById(id)
      .classList
      .add('glow');
  }
}

function renderServices(data) {
  document
    .getElementById(
      'services'
    )
    .innerHTML =
    data.services
      .map(
        function(item) {
          const highlighted =
            data.ui &&
            Array.isArray(
              data.ui.service_ids
            ) &&
            data.ui.service_ids.includes(
              item.id
            ) &&
            actionIsFresh(
              data.ui
            );

          return (
            '<div class="service' +
            (
              highlighted
                ? ' highlight'
                : ''
            ) +
            '">' +

            '<div class="icon">' +
            serviceIcon(
              item.category
            ) +
            '</div>' +

            '<div>' +

            '<div class="name">' +
            esc(
              item.name
            ) +
            '</div>' +

            '<div class="meta">' +
            esc(
              item.duration_min
            ) +
            ' мин</div>' +

            '</div>' +

            '<div class="price">' +
            money(
              item.price_kzt
            ) +
            '</div>' +

            '</div>'
          );
        }
      )
      .join('');
}

function renderSlots(data) {
  const chip =
    document
      .getElementById(
        'displayDate'
      );

  chip.textContent =
    humanDate(
      data.display_date
    );

  if (
    previousDisplayDate !== null &&
    previousDisplayDate !==
      data.display_date
  ) {
    dateFlashUntil =
      Date.now() +
      UI_FLASH_MS;
  }

  previousDisplayDate =
    data.display_date;

  chip.classList.toggle(
    'date-flash',

    Date.now() <
      dateFlashUntil
  );

  document
    .getElementById(
      'slots'
    )
    .innerHTML =
    data.slots
      .map(
        function(slot) {
          const key =
            data.display_date +
            '|' +
            slot.time;

          const previous =
            previousSlotState.get(
              key
            );

          if (
            previous !== undefined &&
            previous !== slot.occupied
          ) {
            slotFlashUntil.set(
              key,

              Date.now() +
              UI_FLASH_MS
            );
          }

          const changed =
            (
              slotFlashUntil.get(
                key
              ) ||
              0
            ) >
            Date.now();

          previousSlotState.set(
            key,
            slot.occupied
          );

          return (
            '<div class="slot ' +
            (
              slot.occupied
                ? 'busy'
                : 'free'
            ) +
            (
              changed
                ? ' changed'
                : ''
            ) +
            '">' +

            '<div>' +
            esc(
              slot.time
            ) +
            '</div>' +

            '<small>' +
            (
              slot.occupied
                ? esc(
                    slot.customer_name ||
                    'Занято'
                  )
                : 'Свободно'
            ) +
            '</small>' +

            '</div>'
          );
        }
      )
      .join('');
}

function renderBooking(data) {
  const root =
    document
      .getElementById(
        'booking'
      );

  const latest =
    data.bookings &&
    data.bookings.length
      ? data.bookings[0]
      : null;

  if (!latest) {
    root.innerHTML =
      '<div class="booking-empty">' +
      'Пока нет записей.<br>' +
      'Новая бронь появится здесь автоматически.' +
      '</div>';

    return;
  }

  const statusClass =
    latest.status ===
    'cancelled'
      ? 'cancelled'
      : 'confirmed';

  const statusText =
    latest.status ===
    'cancelled'
      ? 'Отменено'
      : 'Подтверждено';

  root.innerHTML =
    '<div class="booking-card">' +

    '<div class="booking-person">' +

    '<div class="avatar">' +
    '👤' +
    '</div>' +

    '<div>' +

    '<div class="name" style="font-size:17px">' +
    esc(
      latest.customer_name
    ) +
    '</div>' +

    '<div class="meta">' +
    esc(
      latest.booking_id
    ) +
    '</div>' +

    '</div>' +

    '</div>' +

    '<div class="booking-main">' +

    '<div>' +

    '<div class="booking-service">' +
    esc(
      latest.service_name
    ) +
    '</div>' +

    '<div class="booking-time">' +
    '📅 ' +
    humanDate(
      latest.date
    ) +
    ' &nbsp;&nbsp; 🕒 ' +
    esc(
      latest.time
    ) +
    ' &nbsp;&nbsp; • ' +
    money(
      latest.price_kzt
    ) +
    '</div>' +

    '</div>' +

    '<div class="status ' +
    statusClass +
    '">' +
    statusText +
    '</div>' +

    '</div>' +

    '</div>';
}

function renderProducts(data) {
  const highlighted =
    new Set(
      (
        data.ui &&
        data.ui.product_ids
      ) ||
      []
    );

  document
    .getElementById(
      'products'
    )
    .innerHTML =
    data.products
      .map(
        function(item) {
          const highlightClass =
            data.ui &&
            data.ui.focus ===
              'products' &&
            highlighted.has(
              item.id
            ) &&
            actionIsFresh(
              data.ui
            )
              ? ' highlight'
              : '';

          const stockClass =
            item.stock > 0
              ? 'stock'
              : 'stock out';

          const stockHighlightClass =
            data.ui &&
            data.ui.focus ===
              'products' &&
            data.ui.last_action ===
              'product_stock_checked' &&
            highlighted.has(
              item.id
            ) &&
            actionIsFresh(
              data.ui
            )
              ? ' stock-highlight'
              : '';

          const stockText =
            item.stock > 0
              ? item.stock +
                ' шт.'
              : 'Нет в наличии';

          return (
            '<div class="product' +
            highlightClass +
            '">' +

            '<div class="icon">' +
            productIcon(
              item.category
            ) +
            '</div>' +

            '<div>' +

            '<div class="name">' +
            esc(
              item.name
            ) +
            '</div>' +

            '<div class="meta">' +
            esc(
              item.category
            ) +
            '</div>' +

            '</div>' +

            '<div style="text-align:right">' +

            '<div class="price">' +
            money(
              item.price_kzt
            ) +
            '</div>' +

            '<span class="' +
            stockClass +
            stockHighlightClass +
            '">' +

            esc(
              stockText
            ) +

            '</span>' +

            '</div>' +

            '</div>'
          );
        }
      )
      .join('');
}

let busy =
  false;

async function refresh() {
  if (busy) {
    return;
  }

  busy =
    true;

  try {
    const response =
      await fetch(
        '/demo-data',
        {
          cache:
            'no-store'
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        'HTTP ' +
        response.status
      );
    }

    const data =
      await response.json();

    syncUiAction(
      data.ui
    );

    renderServices(
      data
    );

    renderSlots(
      data
    );

    renderBooking(
      data
    );

    renderProducts(
      data
    );

    setGlow(
      data.ui
    );

    document
      .getElementById(
        'updatedAt'
      )
      .textContent =
      'Обновлено ' +
      new Date(
        data.generated_at
      )
      .toLocaleTimeString(
        'ru-RU'
      );

  } catch (
    error
  ) {
    document
      .getElementById(
        'updatedAt'
      )
      .textContent =
      'Нет связи с сервером';

  } finally {
    busy =
      false;
  }
}

refresh();

setInterval(
  refresh,
  500
);

</script>

</body>
</html>`;

const DEMO_SCREEN_HTML =
  DEMO_HTML.replace(
    '</head>',
    `
<style>
  html,
  body {
    background: transparent !important;
  }

  body {
    padding: 14px !important;
  }

.shell {
  filter:
    saturate(1.35)
    contrast(1.12)
    brightness(0.90);
}
  
</style>
</head>`
  );

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
      '1.6.0',

    mcp_endpoint:
      '/mcp',

    demo:
      '/demo',

    demo_data:
      '/demo-data',

    demo_bookings:
      '/bookings',

    debug_ui:
      '/debug-ui'
  })
);

app.get(
  '/debug-ui',
  async (
    request,
    reply
  ) => {
    reply.header(
      'Cache-Control',
      'no-store'
    );

    return {
      ui:
        { ...uiState },

      recent_events:
        [...uiEvents]
          .reverse(),

      bookings:
        latestBookingFirst(
          bookings
        )
    };
  }
);

app.get(
  '/bookings',
  async (
    request,
    reply
  ) => {
    reply.header(
      'Cache-Control',
      'no-store'
    );

    return {
      warning:
        'Demo memory storage: data resets when the server restarts or sleeps.',

      bookings
    };
  }
);

app.get(
  '/demo-data',
  async (
    request,
    reply
  ) => {
    reply.header(
      'Cache-Control',
      'no-store'
    );

    return buildDemoData();
  }
);

app.get(
  '/demo',
  async (
    request,
    reply
  ) => {
    reply.header(
      'Cache-Control',
      'no-store'
    );

    reply.type(
      'text/html; charset=utf-8'
    );

    return DEMO_HTML;
  }
);

app.get(
  '/demo-screen',
  async (
    request,
    reply
  ) => {
    reply.header(
      'Cache-Control',
      'no-store'
    );

    reply.type(
      'text/html; charset=utf-8'
    );

    return DEMO_SCREEN_HTML;
  }
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
  'Yeti Nail Studio MCP v1.6.0 running on port ' +
  port
);
