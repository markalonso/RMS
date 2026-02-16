import { z } from 'zod';

export const tableCodeSchema = z.string().min(3).max(12).regex(/^[A-Z0-9-]+$/);

export const customerRequestSchema = z.object({
  tableCode: tableCodeSchema,
  itemId: z.string().uuid(),
  qty: z.number().int().positive().max(20),
  note: z.string().max(200).optional()
});

export type CustomerRequest = z.infer<typeof customerRequestSchema>;

export const orderTicketSchema = z.object({
  orderId: z.string().uuid(),
  tableCode: tableCodeSchema,
  createdAt: z.string().datetime(),
  lines: z.array(
    z.object({
      name: z.string(),
      qty: z.number().int().positive(),
      note: z.string().optional()
    })
  )
});

export type OrderTicket = z.infer<typeof orderTicketSchema>;

export const appCapabilities = {
  mainPosOnly: true,
  kitchenScreen: false,
  kitchenTicketPrint: true,
  customerCanViewBills: false,
  customerCanViewExistingOrders: false,
  customerCanPlaceOrderRequest: true
} as const;
