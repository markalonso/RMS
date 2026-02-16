'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

import { supabase } from '@/lib/supabase';

type TableCard = {
  table_number: number;
  name: string;
  is_active: boolean;
  qr_enabled: boolean;
  has_open_session: boolean;
  pending_qr_count: number;
};

type DashboardData = {
  open_business_day: {
    id: string;
    status: 'open' | 'closed';
    opened_at: string;
    opening_cash: number;
  } | null;
  tables: TableCard[];
};

type QueueItem = {
  order_id: string;
  session_id: string;
  table_number: number | null;
  created_at: string;
  customer_note: string | null;
  items: Array<{
    id: string;
    menu_item_name: string;
    qty: number;
    notes: string | null;
  }>;
};

type MenuCategory = { id: string; name: string; sort_order: number };
type MenuItem = { id: string; category_id: string; name: string; description: string | null; price: number };
type ItemModifierGroup = { menu_item_id: string; modifier_group_id: string; is_required: boolean; min_select: number; max_select: number };
type ModifierGroup = { id: string; name: string };
type Modifier = { id: string; modifier_group_id: string; name: string; price_delta: number };
type AvailabilityRow = { menu_item_id: string; is_available: boolean };

type SessionDetails = {
  session: {
    id: string;
    table_number: number | null;
    order_type: 'dine_in' | 'takeaway' | 'delivery';
    status: 'open' | 'closed';
    customer_name: string | null;
    customer_phone: string | null;
    customer_address: string | null;
  } | null;
  orders: Array<{
    id: string;
    source: 'qr' | 'manual';
    status: string;
    created_at: string;
    items: Array<{
      id: string;
      menu_item_id: string;
      menu_item_name: string;
      qty: number;
      notes: string | null;
      selected_modifiers: Array<{ id?: string; name?: string }>;
      kitchen_printed_at: string | null;
      editable_before_print: boolean;
    }>;
  }>;
  bill: {
    subtotal: number;
    discount_amount: number;
    tax_amount: number;
    delivery_fee: number;
    total: number;
    payment_status: string;
  } | null;
};

type ManualModalState = {
  mode: 'add' | 'edit';
  orderItemId?: string;
  item: MenuItem;
  qty: number;
  notes: string;
  selectedByGroup: Record<string, string[]>;
};

type BillSplitRow = {
  id: string;
  split_method: 'items' | 'even';
  portion_index: number;
  portions_count: number;
  subtotal: number;
  discount_amount: number;
  new_subtotal: number;
  tax_amount: number;
  delivery_fee: number;
  total: number;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

const TABLE_PRELOAD_COUNT = 24;

export function PosWorkspace() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedTable, setSelectedTable] = useState<number | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetails, setSessionDetails] = useState<SessionDetails | null>(null);
  const [role, setRole] = useState<'owner' | 'cashier' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);

  const [openingCash, setOpeningCash] = useState('0');
  const [closingCash, setClosingCash] = useState('0');
  const [deliveryName, setDeliveryName] = useState('');
  const [deliveryPhone, setDeliveryPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('0');
  const [billDiscount, setBillDiscount] = useState('0');
  const [billDeliveryFee, setBillDeliveryFee] = useState('0');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card'>('cash');
  const [paymentAmount, setPaymentAmount] = useState('0');

  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [availabilityByItem, setAvailabilityByItem] = useState<Record<string, boolean>>({});
  const [itemModifierGroups, setItemModifierGroups] = useState<ItemModifierGroup[]>([]);
  const [modifierGroups, setModifierGroups] = useState<ModifierGroup[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);

  const [manualModal, setManualModal] = useState<ManualModalState | null>(null);
  const [manualCategoryId, setManualCategoryId] = useState<string | null>(null);
  const [billSplits, setBillSplits] = useState<BillSplitRow[]>([]);
  const [splitItemIds, setSplitItemIds] = useState<string[]>([]);
  const [splitEvenCount, setSplitEvenCount] = useState('2');
  const [openDineInTables, setOpenDineInTables] = useState<number[]>([]);
  const [mergeTargetTable, setMergeTargetTable] = useState('');
  const [mergeSourceTable, setMergeSourceTable] = useState('');

  const selectedTableCard = useMemo(
    () => dashboard?.tables.find((t) => t.table_number === selectedTable) ?? null,
    [dashboard?.tables, selectedTable]
  );

  const modifierGroupById = useMemo(
    () => Object.fromEntries(modifierGroups.map((g) => [g.id, g])),
    [modifierGroups]
  );

  const modifiersByGroup = useMemo(() => {
    const map: Record<string, Modifier[]> = {};
    for (const mod of modifiers) {
      map[mod.modifier_group_id] = map[mod.modifier_group_id] ?? [];
      map[mod.modifier_group_id].push(mod);
    }
    return map;
  }, [modifiers]);

  const modalGroups = useMemo(() => {
    if (!manualModal) return [];
    return itemModifierGroups.filter((g) => g.menu_item_id === manualModal.item.id);
  }, [itemModifierGroups, manualModal]);

  const loadRole = async () => {
    const { data, error: roleError } = await supabase.rpc('pos_get_my_role');
    if (roleError) {
      setError(roleError.message);
      return;
    }
    setRole(data as 'owner' | 'cashier');
  };

  const loadMenu = async () => {
    const [categoryRes, itemRes, availabilityRes, imgRes, groupRes, modifierRes] = await Promise.all([
      supabase.from('menu_categories').select('id,name,sort_order').eq('is_active', true).is('deleted_at', null).order('sort_order', { ascending: true }),
      supabase.from('menu_items').select('id,category_id,name,description,price').eq('is_active', true).is('deleted_at', null).order('name', { ascending: true }),
      supabase.from('item_availability').select('menu_item_id,is_available'),
      supabase.from('item_modifier_groups').select('menu_item_id,modifier_group_id,is_required,min_select,max_select').is('deleted_at', null),
      supabase.from('modifier_groups').select('id,name').eq('is_active', true).is('deleted_at', null),
      supabase.from('modifiers').select('id,modifier_group_id,name,price_delta').eq('is_active', true).is('deleted_at', null)
    ]);

    if (categoryRes.error || itemRes.error || availabilityRes.error || imgRes.error || groupRes.error || modifierRes.error) {
      setError('Failed to load menu data');
      return;
    }

    setCategories((categoryRes.data as MenuCategory[]) ?? []);
    setItems((itemRes.data as MenuItem[]) ?? []);
    setItemModifierGroups((imgRes.data as ItemModifierGroup[]) ?? []);
    setModifierGroups((groupRes.data as ModifierGroup[]) ?? []);
    setModifiers((modifierRes.data as Modifier[]) ?? []);
    const map: Record<string, boolean> = {};
    for (const a of ((availabilityRes.data as AvailabilityRow[]) ?? [])) {
      map[a.menu_item_id] = a.is_available;
    }
    setAvailabilityByItem(map);
    if (!manualCategoryId && (categoryRes.data as MenuCategory[])?.[0]?.id) {
      setManualCategoryId((categoryRes.data as MenuCategory[])[0].id);
    }
  };

  const loadDashboard = async () => {
    const { data, error: dashError } = await supabase.rpc('pos_get_dashboard');
    if (dashError) {
      setError(dashError.message);
      return;
    }

    const raw = (data as DashboardData) ?? { open_business_day: null, tables: [] };
    const byNumber = new Map(raw.tables.map((t) => [t.table_number, t]));
    for (let n = 1; n <= TABLE_PRELOAD_COUNT; n += 1) {
      if (!byNumber.has(n)) {
        raw.tables.push({
          table_number: n,
          name: `Table ${n}`,
          is_active: false,
          qr_enabled: false,
          has_open_session: false,
          pending_qr_count: 0
        });
      }
    }

    raw.tables.sort((a, b) => a.table_number - b.table_number);
    setDashboard(raw);
  };

  const loadQueue = async (sessionId?: string | null) => {
    const { data, error: queueError } = await supabase.rpc('pos_get_pending_qr_queue', {
      p_session_id: sessionId ?? null
    });
    if (queueError) {
      setError(queueError.message);
      return;
    }
    setQueue((data as QueueItem[]) ?? []);
  };

  const loadSessionDetails = async (sessionId: string) => {
    const { data, error: detailsError } = await supabase.rpc('pos_get_session_details', {
      p_session_id: sessionId
    });
    if (detailsError) {
      setError(detailsError.message);
      return;
    }
    setSessionDetails((data as SessionDetails) ?? null);
  };


  const loadBillSplits = async (sessionId: string) => {
    const { data, error: splitError } = await supabase
      .from('bill_splits')
      .select('id,split_method,portion_index,portions_count,subtotal,discount_amount,new_subtotal,tax_amount,delivery_fee,total,created_at,metadata')
      .eq('session_id', sessionId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (splitError) {
      setError(splitError.message);
      return;
    }
    setBillSplits((data as BillSplitRow[]) ?? []);
  };

  const loadOpenDineInTables = async () => {
    const { data, error: tError } = await supabase
      .from('sessions')
      .select('table_number')
      .eq('status', 'open')
      .eq('order_type', 'dine_in')
      .is('deleted_at', null)
      .not('table_number', 'is', null);
    if (tError) {
      setError(tError.message);
      return;
    }
    const nums = ((data as Array<{ table_number: number }>) ?? []).map((r) => r.table_number).filter(Boolean);
    setOpenDineInTables(Array.from(new Set(nums)).sort((a,b)=>a-b));
  };

  const refreshAll = async (sessionId?: string | null) => {
    setLoading(true);
    setError(null);
    await Promise.all([loadDashboard(), loadRole(), loadMenu(), loadOpenDineInTables()]);
    await loadQueue(sessionId ?? selectedSessionId);
    if (sessionId ?? selectedSessionId) {
      const sid = (sessionId ?? selectedSessionId) as string;
      await loadSessionDetails(sid);
      await loadBillSplits(sid);
    } else {
      setBillSplits([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void refreshAll(null);
  }, []);

  useEffect(() => {
    if (selectedSessionId) {
      void loadSessionDetails(selectedSessionId);
      void loadQueue(selectedSessionId);
      void loadBillSplits(selectedSessionId);
    } else {
      setBillSplits([]);
    }
  }, [selectedSessionId]);


  useEffect(() => {
    if (!sessionDetails?.bill) return;
    setBillDiscount(String(sessionDetails.bill.discount_amount ?? 0));
    setBillDeliveryFee(String(sessionDetails.bill.delivery_fee ?? 0));
    const due = Math.max(0, Number(sessionDetails.bill.total ?? 0));
    setPaymentAmount(String(due));
  }, [sessionDetails?.bill?.discount_amount, sessionDetails?.bill?.delivery_fee, sessionDetails?.bill?.total]);

  const startBusinessDay = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const { error: startError } = await supabase.rpc('pos_start_business_day', {
      p_opening_cash: Math.max(0, Number(openingCash) || 0)
    });
    if (startError) setError(startError.message);
    else await refreshAll();
    setBusy(false);
  };

  const closeBusinessDay = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const { data, error: closeError } = await supabase.rpc('pos_close_business_day', {
      p_closing_cash: Math.max(0, Number(closingCash) || 0),
      p_notes: null
    });
    if (closeError) setError(closeError.message);
    else {
      setReport((data as Record<string, unknown>) ?? null);
      setSelectedSessionId(null);
      setSessionDetails(null);
      await refreshAll(null);
    }
    setBusy(false);
  };

  const openSession = async (params: {
    orderType: 'dine_in' | 'takeaway' | 'delivery';
    tableNumber?: number | null;
    customerName?: string | null;
    customerPhone?: string | null;
    customerAddress?: string | null;
  }) => {
    if (busy) return;
    setBusy(true);
    const { data, error: openError } = await supabase.rpc('pos_open_session', {
      p_order_type: params.orderType,
      p_table_number: params.tableNumber ?? null,
      p_customer_name: params.customerName ?? null,
      p_customer_phone: params.customerPhone ?? null,
      p_customer_address: params.customerAddress ?? null
    });
    if (openError) {
      setError(openError.message);
      setBusy(false);
      return;
    }
    const newSessionId = data as string;

    if (params.orderType === 'delivery') {
      const { error: billError } = await supabase.from('bills').upsert(
        { session_id: newSessionId, subtotal: 0, discount_amount: 0, delivery_fee: Math.max(0, Number(deliveryFee) || 0) },
        { onConflict: 'session_id' }
      );
      if (billError) setError(billError.message);
    }

    setSelectedSessionId(newSessionId);
    await refreshAll(newSessionId);
    setBusy(false);
  };

  const toggleQr = async (tableNumber: number, nextEnabled: boolean) => {
    if (busy) return;
    setBusy(true);
    const { error: qrError } = await supabase.rpc('pos_toggle_table_qr', {
      p_table_number: tableNumber,
      p_qr_enabled: nextEnabled
    });
    if (qrError) setError(qrError.message);
    else await refreshAll();
    setBusy(false);
  };

  const selectTable = async (tableNumber: number) => {
    setSelectedTable(tableNumber);
    const { data, error: sessionError } = await supabase
      .from('sessions')
      .select('id')
      .eq('table_number', tableNumber)
      .eq('status', 'open')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (sessionError) {
      setError(sessionError.message);
      return;
    }

    setSelectedSessionId(data?.id ?? null);
    if (data?.id) await loadQueue(data.id);
  };

  const acceptOrder = async (orderId: string) => {
    if (busy) return;
    setBusy(true);
    const { error: acceptError } = await supabase.rpc('pos_accept_qr_order', { p_order_id: orderId });
    if (acceptError) setError(acceptError.message);
    else await refreshAll();
    setBusy(false);
  };

  const rejectOrder = async (orderId: string) => {
    const reason = window.prompt('Reject reason');
    if (!reason) return;
    if (busy) return;
    setBusy(true);
    const { error: rejectError } = await supabase.rpc('pos_reject_qr_order', {
      p_order_id: orderId,
      p_reason: reason
    });
    if (rejectError) setError(rejectError.message);
    else await refreshAll();
    setBusy(false);
  };

  const printOrder = async (orderId: string) => {
    if (busy) return;
    setBusy(true);
    const { error: printError } = await supabase.rpc('pos_print_order_to_kitchen', {
      p_order_id: orderId
    });
    if (printError) {
      setError(printError.message);
      setBusy(false);
      return;
    }
    window.open(`/pos/print/order/${orderId}`, '_blank', 'noopener,noreferrer');
    await refreshAll();
    setBusy(false);
  };


  const applyBillAdjustments = async () => {
    if (!selectedSessionId || busy) return;
    setBusy(true);
    const { error: adjustError } = await supabase.rpc('pos_set_bill_adjustments', {
      p_session_id: selectedSessionId,
      p_discount_amount: Math.max(0, Number(billDiscount) || 0),
      p_delivery_fee: Math.max(0, Number(billDeliveryFee) || 0)
    });
    if (adjustError) setError(adjustError.message);
    else await refreshAll(selectedSessionId);
    setBusy(false);
  };

  const recordPayment = async () => {
    if (!selectedSessionId || busy) return;
    setBusy(true);
    const { error: paymentError } = await supabase.rpc('pos_record_payment', {
      p_session_id: selectedSessionId,
      p_method: paymentMethod,
      p_amount: Math.max(0, Number(paymentAmount) || 0)
    });
    if (paymentError) setError(paymentError.message);
    else await refreshAll(selectedSessionId);
    setBusy(false);
  };

  const printReceipt = () => {
    if (!selectedSessionId) {
      setError('Select a session first.');
      return;
    }
    window.open(`/pos/print/receipt/${selectedSessionId}`, '_blank', 'noopener,noreferrer');
  };


  const mergeTables = async () => {
    const target = Number(mergeTargetTable);
    const source = Number(mergeSourceTable);
    if (!Number.isInteger(target) || !Number.isInteger(source) || target <= 0 || source <= 0) {
      setError('Choose valid table numbers.');
      return;
    }
    if (target === source) {
      setError('Target and source tables must differ.');
      return;
    }
    if (busy) return;
    setBusy(true);
    const { error: mergeError } = await supabase.rpc('pos_merge_tables', {
      p_target_table_number: target,
      p_source_table_number: source
    });
    if (mergeError) setError(mergeError.message);
    else {
      await refreshAll();
      setSelectedTable(target);
      await selectTable(target);
    }
    setBusy(false);
  };

  const splitByItems = async () => {
    if (!selectedSessionId || splitItemIds.length === 0 || busy) {
      setError('Select at least one item for split.');
      return;
    }
    setBusy(true);
    const { error: splitError } = await supabase.rpc('pos_split_bill_by_items', {
      p_session_id: selectedSessionId,
      p_order_item_ids: splitItemIds
    });
    if (splitError) setError(splitError.message);
    else {
      setSplitItemIds([]);
      await refreshAll(selectedSessionId);
    }
    setBusy(false);
  };

  const splitEvenly = async () => {
    if (!selectedSessionId || busy) return;
    const portions = Math.max(2, Number(splitEvenCount) || 2);
    setBusy(true);
    const { error: splitError } = await supabase.rpc('pos_split_bill_evenly', {
      p_session_id: selectedSessionId,
      p_portions: portions
    });
    if (splitError) setError(splitError.message);
    else await refreshAll(selectedSessionId);
    setBusy(false);
  };

  const openAddModal = () => {
    if (!selectedSessionId) {
      setError('Select an open session first.');
      return;
    }
    const categoryItems = items.filter((i) => i.category_id === manualCategoryId);
    const first = categoryItems[0] ?? items[0];
    if (!first) {
      setError('No menu items available.');
      return;
    }
    setManualModal({
      mode: 'add',
      item: first,
      qty: 1,
      notes: '',
      selectedByGroup: {}
    });
  };

  const openEditModal = (orderItem: SessionDetails['orders'][number]['items'][number]) => {
    const item = items.find((i) => i.id === orderItem.menu_item_id);
    if (!item) {
      setError('Menu item not found');
      return;
    }

    const selectedByGroup: Record<string, string[]> = {};
    for (const m of orderItem.selected_modifiers ?? []) {
      if (!m.id) continue;
      const modDef = modifiers.find((md) => md.id === m.id);
      if (!modDef) continue;
      selectedByGroup[modDef.modifier_group_id] = [...(selectedByGroup[modDef.modifier_group_id] ?? []), m.id];
    }

    setManualModal({
      mode: 'edit',
      orderItemId: orderItem.id,
      item,
      qty: orderItem.qty,
      notes: orderItem.notes ?? '',
      selectedByGroup
    });
  };

  const toggleModalModifier = (groupId: string, modifierId: string, maxSelect: number) => {
    if (!manualModal) return;
    const current = manualModal.selectedByGroup[groupId] ?? [];
    let next = current;
    if (current.includes(modifierId)) {
      next = current.filter((id) => id !== modifierId);
    } else if (maxSelect <= 1) {
      next = [modifierId];
    } else if (current.length < maxSelect) {
      next = [...current, modifierId];
    }

    setManualModal({
      ...manualModal,
      selectedByGroup: {
        ...manualModal.selectedByGroup,
        [groupId]: next
      }
    });
  };

  const submitManualModal = async () => {
    if (!manualModal || !selectedSessionId || busy) return;

    for (const group of modalGroups) {
      const selectedCount = (manualModal.selectedByGroup[group.modifier_group_id] ?? []).length;
      if ((group.is_required && selectedCount < group.min_select) || selectedCount > group.max_select) {
        setError('Please complete required modifiers.');
        return;
      }
    }

    const selectedModifiers = Object.values(manualModal.selectedByGroup)
      .flat()
      .map((id) => modifiers.find((m) => m.id === id))
      .filter((v): v is Modifier => Boolean(v))
      .map((m) => ({ id: m.id, name: m.name }));

    setBusy(true);
    if (manualModal.mode === 'add') {
      const { error: addError } = await supabase.rpc('pos_add_manual_item', {
        p_session_id: selectedSessionId,
        p_menu_item_id: manualModal.item.id,
        p_qty: manualModal.qty,
        p_notes: manualModal.notes,
        p_selected_modifiers: selectedModifiers
      });
      if (addError) {
        setError(addError.message);
        setBusy(false);
        return;
      }
    } else {
      const { error: updError } = await supabase.rpc('pos_update_manual_item', {
        p_order_item_id: manualModal.orderItemId,
        p_qty: manualModal.qty,
        p_notes: manualModal.notes,
        p_selected_modifiers: selectedModifiers
      });
      if (updError) {
        setError(updError.message);
        setBusy(false);
        return;
      }
    }

    setManualModal(null);
    await refreshAll(selectedSessionId);
    setBusy(false);
  };

  const removeManualItem = async (orderItemId: string) => {
    if (busy) return;
    setBusy(true);
    const { error: removeError } = await supabase.rpc('pos_remove_manual_item', {
      p_order_item_id: orderItemId
    });
    if (removeError) setError(removeError.message);
    else await refreshAll(selectedSessionId);
    setBusy(false);
  };

  const printNewItems = async () => {
    if (!selectedSessionId || busy) return;
    setBusy(true);
    const { data, error: printError } = await supabase.rpc('pos_print_new_items', {
      p_session_id: selectedSessionId
    });
    if (printError) {
      setError(printError.message);
      setBusy(false);
      return;
    }

    const ids = (((data as { printed_order_ids?: string[] })?.printed_order_ids) ?? []) as string[];
    ids.forEach((id) => window.open(`/pos/print/order/${id}`, '_blank', 'noopener,noreferrer'));
    await refreshAll(selectedSessionId);
    setBusy(false);
  };

  const voidPrintedItem = async (orderItemId: string) => {
    const reason = window.prompt('Void reason');
    if (!reason) return;
    let managerPin: string | null = null;
    if (role !== 'owner') {
      managerPin = window.prompt('Manager PIN (or cancel)');
      if (!managerPin) return;
    }

    if (busy) return;
    setBusy(true);
    const { data, error: voidError } = await supabase.rpc('pos_void_order_item', {
      p_order_item_id: orderItemId,
      p_reason: reason,
      p_manager_pin: managerPin
    });
    if (voidError) {
      setError(voidError.message);
      setBusy(false);
      return;
    }

    const printVoid = window.confirm('Print VOID ticket to kitchen?');
    const voidLogId = (data as { void_log_id?: string })?.void_log_id;
    if (printVoid && voidLogId) {
      window.open(`/pos/print/void/${voidLogId}`, '_blank', 'noopener,noreferrer');
    }

    await refreshAll(selectedSessionId);
    setBusy(false);
  };

  const itemsInManualCategory = items.filter((i) => i.category_id === manualCategoryId);

  return (
    <main className="min-h-screen bg-slate-100 p-4">
      <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-4 rounded-xl bg-white p-4 shadow-sm">
          <h1 className="text-xl font-bold">POS</h1>
          {error ? <p className="rounded bg-red-50 p-2 text-sm text-red-600">{error}</p> : null}
          {loading ? <p className="text-sm text-slate-500">Loading...</p> : null}

          <section className="rounded-lg border p-3">
            <h2 className="font-semibold">Business Day</h2>
            <p className="mb-2 text-sm text-slate-600">
              {dashboard?.open_business_day ? `Open since ${new Date(dashboard.open_business_day.opened_at).toLocaleString()}` : 'No open business day'}
            </p>
            <form onSubmit={startBusinessDay} className="mb-2 flex items-end gap-2">
              <input className="w-full rounded border px-2 py-1 text-sm" type="number" value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} />
              <button type="submit" disabled={busy || Boolean(dashboard?.open_business_day)} className="rounded bg-brand-500 px-3 py-2 text-white disabled:bg-slate-300">Start</button>
            </form>
            <form onSubmit={closeBusinessDay} className="flex items-end gap-2">
              <input className="w-full rounded border px-2 py-1 text-sm" type="number" value={closingCash} onChange={(e) => setClosingCash(e.target.value)} />
              <button type="submit" disabled={busy || !dashboard?.open_business_day} className="rounded bg-slate-900 px-3 py-2 text-white disabled:bg-slate-300">Close</button>
            </form>
          </section>

          <section className="rounded-lg border p-3">
            <h2 className="mb-2 font-semibold">New Sessions</h2>
            <button onClick={() => void openSession({ orderType: 'takeaway' })} disabled={busy || !dashboard?.open_business_day} className="mb-2 w-full rounded bg-brand-700 px-3 py-2 text-sm text-white disabled:bg-slate-300">New Takeaway</button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!deliveryName.trim() || !deliveryPhone.trim() || !deliveryAddress.trim()) {
                  setError('Delivery name/phone/address required');
                  return;
                }
                void openSession({ orderType: 'delivery', customerName: deliveryName, customerPhone: deliveryPhone, customerAddress: deliveryAddress });
              }}
              className="space-y-2"
            >
              <input className="w-full rounded border px-2 py-1 text-sm" placeholder="Name" value={deliveryName} onChange={(e) => setDeliveryName(e.target.value)} />
              <input className="w-full rounded border px-2 py-1 text-sm" placeholder="Phone" value={deliveryPhone} onChange={(e) => setDeliveryPhone(e.target.value)} />
              <textarea className="w-full rounded border px-2 py-1 text-sm" placeholder="Address" value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} />
              <input className="w-full rounded border px-2 py-1 text-sm" placeholder="Delivery fee" type="number" value={deliveryFee} onChange={(e) => setDeliveryFee(e.target.value)} />
              <button type="submit" disabled={busy || !dashboard?.open_business_day} className="w-full rounded bg-brand-500 px-3 py-2 text-sm text-white disabled:bg-slate-300">Create Delivery</button>
            </form>
          </section>

          <section>
            <h2 className="mb-2 font-semibold">Tables</h2>
            <div className="grid grid-cols-3 gap-2">
              {dashboard?.tables.map((table) => (
                <button key={table.table_number} onClick={() => void selectTable(table.table_number)} className={`rounded border p-2 text-left text-xs ${selectedTable === table.table_number ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}>
                  <p className="font-semibold">T{table.table_number}</p>
                  <p className={table.has_open_session ? 'text-emerald-700' : 'text-slate-500'}>{table.has_open_session ? 'Open' : 'Closed'}</p>
                  <p>QR: {table.qr_enabled ? 'On' : 'Off'}</p>
                  <p>Pending: {table.pending_qr_count}</p>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="space-y-4 rounded-xl bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Session + QR Queue</h2>

          {selectedTableCard ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Table {selectedTableCard.table_number}</span>
              <button onClick={() => void toggleQr(selectedTableCard.table_number, !selectedTableCard.qr_enabled)} className="rounded border px-2 py-1">{selectedTableCard.qr_enabled ? 'Disable QR' : 'Enable QR'}</button>
              <button onClick={() => void openSession({ orderType: 'dine_in', tableNumber: selectedTableCard.table_number })} disabled={busy || !dashboard?.open_business_day || selectedTableCard.has_open_session || !selectedTableCard.is_active} className="rounded bg-brand-700 px-2 py-1 text-white disabled:bg-slate-300">Open Dine-in</button>
            </div>
          ) : null}

          <div className="rounded-lg border p-3">
            <h3 className="mb-2 font-semibold">Pending QR Orders</h3>
            {queue.length === 0 ? <p className="text-sm text-slate-500">No pending QR requests.</p> : null}
            <div className="space-y-3">
              {queue.map((q) => (
                <div key={q.order_id} className="rounded border border-slate-200 p-2 text-sm">
                  <p className="font-medium">Order {q.order_id} · Session {q.session_id} · {q.table_number ? `Table ${q.table_number}` : 'No table'}</p>
                  <ul className="mt-1 list-disc pl-5">{q.items.map((item) => <li key={item.id}>{item.menu_item_name} × {item.qty}{item.notes ? ` (${item.notes})` : ''}</li>)}</ul>
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => void acceptOrder(q.order_id)} disabled={busy} className="rounded bg-emerald-600 px-2 py-1 text-white disabled:bg-slate-300">Accept</button>
                    <button onClick={() => void rejectOrder(q.order_id)} disabled={busy} className="rounded bg-red-600 px-2 py-1 text-white disabled:bg-slate-300">Reject</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {sessionDetails?.session ? (
            <>
              <div className="flex flex-wrap gap-2">
                <button onClick={openAddModal} disabled={busy || !selectedSessionId} className="rounded bg-brand-700 px-3 py-2 text-sm text-white disabled:bg-slate-300">Add Item</button>
                <button onClick={() => void printNewItems()} disabled={busy || !selectedSessionId} className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:bg-slate-300">Print New Items Only</button>
              </div>


              <div className="rounded-lg border p-3 text-sm">
                <h3 className="mb-2 font-semibold">Merge Tables (Dine-in)</h3>
                <div className="grid gap-2 md:grid-cols-4">
                  <select className="rounded border px-2 py-1" value={mergeTargetTable} onChange={(e) => setMergeTargetTable(e.target.value)}>
                    <option value="">Target table (A)</option>
                    {openDineInTables.map((n) => <option key={`t-${n}`} value={n}>{n}</option>)}
                  </select>
                  <select className="rounded border px-2 py-1" value={mergeSourceTable} onChange={(e) => setMergeSourceTable(e.target.value)}>
                    <option value="">Source table (B)</option>
                    {openDineInTables.map((n) => <option key={`s-${n}`} value={n}>{n}</option>)}
                  </select>
                  <button className="rounded bg-amber-600 px-2 py-1 text-white disabled:bg-slate-300" disabled={busy} onClick={() => void mergeTables()}>Merge B into A</button>
                </div>
              </div>

              <div className="rounded-lg border p-3 text-sm">
                <p>Session: {sessionDetails.session.id}</p>
                <p>Type: {sessionDetails.session.order_type}</p>
                <p>Status: {sessionDetails.session.status}</p>
                {sessionDetails.session.table_number ? <p>Table: {sessionDetails.session.table_number}</p> : null}
                {sessionDetails.session.order_type === 'delivery' ? (
                  <>
                    <p>Name: {sessionDetails.session.customer_name ?? '-'}</p>
                    <p>Phone: {sessionDetails.session.customer_phone ?? '-'}</p>
                    <p>Address: {sessionDetails.session.customer_address ?? '-'}</p>
                  </>
                ) : null}
              </div>

              <div className="rounded-lg border p-3">
                <h3 className="mb-2 font-semibold">Orders</h3>
                <div className="space-y-2 text-sm">
                  {sessionDetails.orders.map((order) => (
                    <div key={order.id} className="rounded border p-2">
                      <p className="font-medium">{order.id} · {order.source} · {order.status}</p>
                      <ul className="mt-1 list-disc pl-5">
                        {order.items.map((item) => (
                          <li key={item.id}>
                            {item.menu_item_name} × {item.qty}{item.notes ? ` (${item.notes})` : ''}
                            <span className="ml-2 text-xs text-slate-500">{item.kitchen_printed_at ? 'Printed' : 'Not Printed'}</span>
                            <div className="mt-1 flex gap-2">
                              {item.editable_before_print ? (
                                <>
                                  <button onClick={() => openEditModal(item)} className="rounded border px-2 py-0.5 text-xs">Edit</button>
                                  <button onClick={() => void removeManualItem(item.id)} className="rounded border px-2 py-0.5 text-xs text-red-600">Remove</button>
                                </>
                              ) : null}
                              {item.kitchen_printed_at ? (
                                <button onClick={() => void voidPrintedItem(item.id)} className="rounded border px-2 py-0.5 text-xs text-amber-700">Void</button>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                      {order.status === 'accepted' ? (
                        <button onClick={() => void printOrder(order.id)} disabled={busy} className="mt-2 rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:bg-slate-300">Print to Kitchen</button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>


              <div className="rounded-lg border p-3 text-sm">
                <h3 className="mb-2 font-semibold">Split Bill</h3>
                <p className="mb-2 text-xs text-slate-500">Tax rules remain based on order type (dine-in tax after discount).</p>
                <div className="mb-3">
                  <p className="mb-1 text-xs font-medium">Split by items</p>
                  <div className="max-h-36 space-y-1 overflow-auto rounded border p-2">
                    {sessionDetails.orders.flatMap((o) => o.items).map((it) => (
                      <label key={`split-${it.id}`} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={splitItemIds.includes(it.id)}
                          onChange={(e) => setSplitItemIds((prev) => e.target.checked ? [...prev, it.id] : prev.filter((id) => id !== it.id))}
                        />
                        <span>{it.menu_item_name} × {it.qty}</span>
                      </label>
                    ))}
                  </div>
                  <button className="mt-2 rounded border px-2 py-1 text-xs" onClick={() => void splitByItems()} disabled={busy}>Create Item Split</button>
                </div>

                <div>
                  <p className="mb-1 text-xs font-medium">Split evenly</p>
                  <div className="flex items-center gap-2">
                    <input className="w-24 rounded border px-2 py-1 text-xs" type="number" min="2" value={splitEvenCount} onChange={(e) => setSplitEvenCount(e.target.value)} />
                    <button className="rounded border px-2 py-1 text-xs" onClick={() => void splitEvenly()} disabled={busy}>Split by N</button>
                  </div>
                </div>

                <div className="mt-3">
                  <p className="mb-1 text-xs font-medium">Split Results</p>
                  {billSplits.length === 0 ? <p className="text-xs text-slate-500">No splits yet.</p> : null}
                  <div className="space-y-1">
                    {billSplits.map((s) => (
                      <p key={s.id} className="text-xs">#{s.portion_index + 1}/{s.portions_count} · {s.split_method} · subtotal {s.subtotal} · discount {s.discount_amount} · new_subtotal {s.new_subtotal} · tax {s.tax_amount} · delivery {s.delivery_fee} · total {s.total}</p>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-3 text-sm">
                <h3 className="mb-2 font-semibold">Bill Summary</h3>
                {sessionDetails.bill ? (
                  <>
                    <ul className="space-y-1">
                      <li>Subtotal: {sessionDetails.bill.subtotal}</li>
                      <li>Discount: {sessionDetails.bill.discount_amount}</li>
                      <li>New Subtotal: {Math.max(sessionDetails.bill.subtotal - sessionDetails.bill.discount_amount, 0)}</li>
                      <li>Tax: {sessionDetails.bill.tax_amount}</li>
                      <li>Delivery Fee: {sessionDetails.bill.delivery_fee}</li>
                      <li className="font-semibold">Total: {sessionDetails.bill.total}</li>
                      <li>Payment Status: {sessionDetails.bill.payment_status}</li>
                    </ul>

                    <div className="mt-3 grid gap-2 md:grid-cols-4">
                      <label className="text-xs">Discount amount
                        <input className="mt-1 w-full rounded border px-2 py-1" type="number" min="0" step="0.01" value={billDiscount} onChange={(e) => setBillDiscount(e.target.value)} />
                      </label>
                      <label className="text-xs">Delivery fee
                        <input className="mt-1 w-full rounded border px-2 py-1" type="number" min="0" step="0.01" value={billDeliveryFee} onChange={(e) => setBillDeliveryFee(e.target.value)} />
                      </label>
                      <button className="rounded bg-brand-500 px-2 py-1 text-white disabled:bg-slate-300" disabled={busy} onClick={() => void applyBillAdjustments()}>Apply Billing</button>
                      <button className="rounded border px-2 py-1" onClick={printReceipt}>Print Receipt</button>
                    </div>

                    <div className="mt-3 grid gap-2 md:grid-cols-4">
                      <label className="text-xs">Method
                        <select className="mt-1 w-full rounded border px-2 py-1" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as 'cash' | 'card')}>
                          <option value="cash">Cash</option>
                          <option value="card">Card</option>
                        </select>
                      </label>
                      <label className="text-xs">Amount
                        <input className="mt-1 w-full rounded border px-2 py-1" type="number" min="0" step="0.01" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                      </label>
                      <button className="rounded bg-slate-900 px-2 py-1 text-white disabled:bg-slate-300" disabled={busy} onClick={() => void recordPayment()}>Record Payment</button>
                    </div>
                  </>
                ) : <p>No bill yet.</p>}
              </div>
            </>
          ) : <p className="text-sm text-slate-600">Select a table session or create takeaway/delivery.</p>}

          {report ? (
            <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
              <h3 className="font-semibold">End-of-day Report</h3>
              <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(report, null, 2)}</pre>
            </div>
          ) : null}
        </section>
      </div>

      {manualModal ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-4 shadow-lg">
            <h3 className="text-lg font-semibold">{manualModal.mode === 'add' ? 'Add Item' : 'Edit Item'}</h3>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="text-sm">Category
                <select className="mt-1 w-full rounded border p-2" value={manualCategoryId ?? ''} onChange={(e) => {
                  setManualCategoryId(e.target.value);
                  const first = items.find((i) => i.category_id === e.target.value);
                  if (first && manualModal.mode === 'add') {
                    setManualModal({ ...manualModal, item: first, selectedByGroup: {} });
                  }
                }}>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>

              <label className="text-sm">Item
                <select className="mt-1 w-full rounded border p-2" value={manualModal.item.id} onChange={(e) => {
                  const selected = items.find((i) => i.id === e.target.value);
                  if (!selected) return;
                  setManualModal({ ...manualModal, item: selected, selectedByGroup: {} });
                }}>
                  {itemsInManualCategory.map((i) => (
                    <option key={i.id} value={i.id} disabled={availabilityByItem[i.id] === false}>{i.name} ({i.price})</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <span>Qty</span>
              <button className="rounded border px-2" onClick={() => setManualModal((m) => (m ? { ...m, qty: Math.max(1, m.qty - 1) } : m))}>-</button>
              <span>{manualModal.qty}</span>
              <button className="rounded border px-2" onClick={() => setManualModal((m) => (m ? { ...m, qty: m.qty + 1 } : m))}>+</button>
            </div>

            <label className="mt-3 block text-sm">Notes
              <textarea className="mt-1 w-full rounded border p-2" value={manualModal.notes} onChange={(e) => setManualModal((m) => (m ? { ...m, notes: e.target.value } : m))} maxLength={200} />
            </label>

            <div className="mt-4 space-y-3">
              {modalGroups.map((groupRule) => {
                const group = modifierGroupById[groupRule.modifier_group_id];
                if (!group) return null;
                const selected = manualModal.selectedByGroup[group.id] ?? [];
                const groupMods = modifiersByGroup[group.id] ?? [];
                return (
                  <div key={group.id} className="rounded border p-3">
                    <p className="font-medium" dir="ltr">{group.name}</p>
                    <p className="text-xs text-slate-500">{groupRule.is_required ? 'Required' : 'Optional'} · {groupRule.min_select}-{groupRule.max_select}</p>
                    <div className="mt-2 grid gap-2">
                      {groupMods.map((mod) => (
                        <label key={mod.id} className="flex items-center gap-2 text-sm" dir="ltr">
                          <input type={groupRule.max_select > 1 ? 'checkbox' : 'radio'} checked={selected.includes(mod.id)} onChange={() => toggleModalModifier(group.id, mod.id, groupRule.max_select)} />
                          <span>{mod.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border px-3 py-1" onClick={() => setManualModal(null)}>Cancel</button>
              <button className="rounded bg-brand-500 px-3 py-1 text-white" onClick={() => void submitManualModal()}>{manualModal.mode === 'add' ? 'Add' : 'Save'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
