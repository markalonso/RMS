'use client';

import { useEffect, useMemo, useState } from 'react';

import { supabase } from '@/lib/supabase';

type Lang = 'en' | 'ar';

type Dictionary = {
  pageTitle: string;
  tableUnavailable: string;
  noOpenSession: string;
  categories: string;
  add: string;
  cart: string;
  emptyCart: string;
  qty: string;
  notes: string;
  optional: string;
  required: string;
  minMax: (min: number, max: number) => string;
  confirmAdd: string;
  cancel: string;
  remove: string;
  submit: string;
  submitting: string;
  sent: string;
  addAnother: string;
  validationNeedItems: string;
  validationNeedModifier: string;
  unavailableNow: string;
};

const text: Record<Lang, Dictionary> = {
  en: {
    pageTitle: 'Table Ordering',
    tableUnavailable: 'This table QR is disabled or the table is inactive. Please ask staff for help.',
    noOpenSession: 'Ordering not available right now.',
    categories: 'Categories',
    add: 'Add',
    cart: 'Cart',
    emptyCart: 'Your cart is empty.',
    qty: 'Qty',
    notes: 'Notes',
    optional: 'Optional',
    required: 'Required',
    minMax: (min, max) => `Choose ${min}-${max}`,
    confirmAdd: 'Confirm add',
    cancel: 'Cancel',
    remove: 'Remove',
    submit: 'Submit order request',
    submitting: 'Submitting...',
    sent: 'Order sent for approval.',
    addAnother: 'You can send another request as a separate order.',
    validationNeedItems: 'Please add at least one item.',
    validationNeedModifier: 'Please satisfy required modifier selections.',
    unavailableNow: 'Ordering not available right now.'
  },
  ar: {
    pageTitle: 'طلب الطاولة',
    tableUnavailable: 'رمز QR لهذه الطاولة معطّل أو الطاولة غير نشطة. يرجى طلب المساعدة من الموظفين.',
    noOpenSession: 'الطلب غير متاح الآن.',
    categories: 'الفئات',
    add: 'إضافة',
    cart: 'السلة',
    emptyCart: 'السلة فارغة.',
    qty: 'الكمية',
    notes: 'ملاحظات',
    optional: 'اختياري',
    required: 'إلزامي',
    minMax: (min, max) => `اختر ${min}-${max}`,
    confirmAdd: 'تأكيد الإضافة',
    cancel: 'إلغاء',
    remove: 'حذف',
    submit: 'إرسال طلب الطلب',
    submitting: 'جاري الإرسال...',
    sent: 'تم إرسال الطلب للموافقة.',
    addAnother: 'يمكنك إرسال طلب إضافي كطلب منفصل.',
    validationNeedItems: 'يرجى إضافة عنصر واحد على الأقل.',
    validationNeedModifier: 'يرجى استكمال خيارات المضافات الإلزامية.',
    unavailableNow: 'الطلب غير متاح الآن.'
  }
};

type CategoryRow = { id: string; name: string; sort_order: number };

type ItemRow = {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  price: number;
};

type AvailabilityRow = { menu_item_id: string; is_available: boolean };

type ItemModifierGroupRow = {
  menu_item_id: string;
  modifier_group_id: string;
  is_required: boolean;
  min_select: number;
  max_select: number;
};

type ModifierGroupRow = {
  id: string;
  name: string;
};

type ModifierRow = {
  id: string;
  modifier_group_id: string;
  name: string;
  price_delta: number;
};

type ModalState = {
  item: ItemRow;
  qty: number;
  notes: string;
  selectedByGroup: Record<string, string[]>;
};

type CartItem = {
  id: string;
  menu_item_id: string;
  name: string;
  qty: number;
  notes?: string;
  selected_modifiers: { id: string; name: string }[];
};

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

export function TableOrderPage({ tableNumber }: { tableNumber: string }) {
  const parsedTableNumber = Number(tableNumber);
  const [lang, setLang] = useState<Lang>('en');
  const [loading, setLoading] = useState(true);
  const [disabledReason, setDisabledReason] = useState<string | null>(null);
  const [hasOpenSession, setHasOpenSession] = useState(false);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [availabilityByItem, setAvailabilityByItem] = useState<Record<string, boolean>>({});
  const [itemModifierGroups, setItemModifierGroups] = useState<ItemModifierGroupRow[]>([]);
  const [modifierGroups, setModifierGroups] = useState<ModifierGroupRow[]>([]);
  const [modifiers, setModifiers] = useState<ModifierRow[]>([]);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const t = text[lang];
  const rtl = lang === 'ar';

  const groupedItems = useMemo(() => {
    return categories.map((category) => ({
      category,
      items: items.filter((item) => item.category_id === category.id)
    }));
  }, [categories, items]);

  const modifierGroupById = useMemo(
    () => Object.fromEntries(modifierGroups.map((group) => [group.id, group])),
    [modifierGroups]
  );

  const modifiersByGroup = useMemo(() => {
    const map: Record<string, ModifierRow[]> = {};
    for (const modifier of modifiers) {
      map[modifier.modifier_group_id] = map[modifier.modifier_group_id] ?? [];
      map[modifier.modifier_group_id].push(modifier);
    }
    return map;
  }, [modifiers]);

  useEffect(() => {
    const load = async () => {
      if (!Number.isInteger(parsedTableNumber) || parsedTableNumber <= 0) {
        setDisabledReason(t.unavailableNow);
        setHasOpenSession(false);
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMessage(null);

      const { data: tableStatus, error: tableStatusError } = await supabase.rpc('get_table_ordering_status', {
        p_table_number: parsedTableNumber
      });

      if (tableStatusError || !tableStatus) {
        setDisabledReason(t.unavailableNow);
        setHasOpenSession(false);
        setLoading(false);
        return;
      }

      if (!tableStatus.table_exists || !tableStatus.is_active || !tableStatus.qr_enabled) {
        setDisabledReason(t.tableUnavailable);
        setHasOpenSession(false);
      } else if (!tableStatus.has_open_session) {
        setDisabledReason(t.noOpenSession);
        setHasOpenSession(false);
      } else {
        setDisabledReason(null);
        setHasOpenSession(true);
      }

      const [categoryRes, itemRes, availabilityRes, itemGroupRes, groupRes, modifierRes] = await Promise.all([
        supabase.from('menu_categories').select('id,name,sort_order').eq('is_active', true).is('deleted_at', null).order('sort_order', { ascending: true }),
        supabase
          .from('menu_items')
          .select('id,category_id,name,description,price')
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('name', { ascending: true }),
        supabase.from('item_availability').select('menu_item_id,is_available'),
        supabase.from('item_modifier_groups').select('menu_item_id,modifier_group_id,is_required,min_select,max_select').is('deleted_at', null),
        supabase.from('modifier_groups').select('id,name').eq('is_active', true).is('deleted_at', null),
        supabase.from('modifiers').select('id,modifier_group_id,name,price_delta').eq('is_active', true).is('deleted_at', null)
      ]);

      if (categoryRes.error || itemRes.error || availabilityRes.error || itemGroupRes.error || groupRes.error || modifierRes.error) {
        setErrorMessage('Failed to load menu data.');
      } else {
        setCategories((categoryRes.data as CategoryRow[]) ?? []);
        setItems((itemRes.data as ItemRow[]) ?? []);
        setItemModifierGroups((itemGroupRes.data as ItemModifierGroupRow[]) ?? []);
        setModifierGroups((groupRes.data as ModifierGroupRow[]) ?? []);
        setModifiers((modifierRes.data as ModifierRow[]) ?? []);

        const availabilityMap: Record<string, boolean> = {};
        for (const row of (availabilityRes.data as AvailabilityRow[]) ?? []) {
          availabilityMap[row.menu_item_id] = row.is_available;
        }
        setAvailabilityByItem(availabilityMap);
      }

      setLoading(false);
    };

    void load();
  }, [parsedTableNumber, t.noOpenSession, t.tableUnavailable, t.unavailableNow]);

  const openItemModal = (item: ItemRow) => {
    setModal({ item, qty: 1, notes: '', selectedByGroup: {} });
  };

  const itemGroupsForModal = useMemo(() => {
    if (!modal) return [];
    return itemModifierGroups.filter((g) => g.menu_item_id === modal.item.id);
  }, [itemModifierGroups, modal]);

  const toggleModifier = (groupId: string, modifierId: string, maxSelect: number) => {
    if (!modal) return;
    const current = modal.selectedByGroup[groupId] ?? [];
    let next = current;

    if (current.includes(modifierId)) {
      next = current.filter((id) => id !== modifierId);
    } else if (maxSelect <= 1) {
      next = [modifierId];
    } else if (current.length < maxSelect) {
      next = [...current, modifierId];
    }

    setModal({
      ...modal,
      selectedByGroup: {
        ...modal.selectedByGroup,
        [groupId]: next
      }
    });
  };

  const confirmAdd = () => {
    if (!modal) return;

    for (const group of itemGroupsForModal) {
      const selectedCount = (modal.selectedByGroup[group.modifier_group_id] ?? []).length;
      if ((group.is_required && selectedCount < group.min_select) || selectedCount > group.max_select) {
        setErrorMessage(t.validationNeedModifier);
        return;
      }
    }

    const selectedModifiers = Object.values(modal.selectedByGroup)
      .flat()
      .map((id) => modifiers.find((m) => m.id === id))
      .filter((v): v is ModifierRow => Boolean(v))
      .map((m) => ({ id: m.id, name: m.name }));

    setCart((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        menu_item_id: modal.item.id,
        name: modal.item.name,
        qty: modal.qty,
        notes: modal.notes.trim() || undefined,
        selected_modifiers: selectedModifiers
      }
    ]);
    setModal(null);
    setErrorMessage(null);
  };

  const submitOrder = async () => {
    if (isSubmitting) return;

    if (!hasOpenSession) {
      setErrorMessage(t.noOpenSession);
      return;
    }

    if (cart.length === 0) {
      setErrorMessage(t.validationNeedItems);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setSubmitMessage(null);

    const payload = cart.map((ci) => ({
      menu_item_id: ci.menu_item_id,
      qty: ci.qty,
      notes: ci.notes,
      selected_modifiers: ci.selected_modifiers
    }));

    const { error } = await supabase.rpc('submit_qr_order_request', {
      p_table_number: parsedTableNumber,
      p_items: payload,
      p_customer_note: null
    });

    if (error) {
      setErrorMessage(error.message.includes('No open session') ? t.noOpenSession : error.message);
      setIsSubmitting(false);
      return;
    }

    setCart([]);
    setSubmitMessage(t.sent);
    setIsSubmitting(false);
  };

  return (
    <div dir={rtl ? 'rtl' : 'ltr'} className="min-h-screen bg-slate-100 p-4 text-slate-900">
      <div className="mx-auto max-w-6xl">
        <header className="mb-4 rounded-xl bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">
              {t.pageTitle} #{parsedTableNumber}
            </h1>
            <button
              type="button"
              className="rounded-md border border-slate-300 px-3 py-1 text-sm"
              onClick={() => setLang((prev) => (prev === 'en' ? 'ar' : 'en'))}
            >
              {lang === 'en' ? 'العربية' : 'English'}
            </button>
          </div>
          {submitMessage ? <p className="mt-2 text-sm text-emerald-700">{submitMessage} {t.addAnother}</p> : null}
          {errorMessage ? <p className="mt-2 text-sm text-red-600">{errorMessage}</p> : null}
        </header>

        {loading ? (
          <div className="rounded-xl bg-white p-6">Loading...</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <section className="rounded-xl bg-white p-4 shadow-sm">
              {disabledReason ? <p className="mb-4 rounded-lg bg-amber-50 p-3 text-amber-800">{disabledReason}</p> : null}

              <h2 className="mb-3 text-lg font-semibold">{t.categories}</h2>
              <div className="space-y-6">
                {groupedItems.map(({ category, items: categoryItems }) => (
                  <div key={category.id}>
                    <h3 className="mb-2 text-base font-semibold">{category.name}</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      {categoryItems.map((item) => {
                        const available = availabilityByItem[item.id] ?? true;
                        return (
                          <article key={item.id} className="rounded-lg border border-slate-200 p-3">
                            <p className="font-semibold" dir="ltr">
                              {item.name}
                            </p>
                            <p className="text-sm text-slate-600">{item.description}</p>
                            <div className="mt-2 flex items-center justify-between">
                              <span className="text-sm font-medium">{currency.format(item.price)}</span>
                              <button
                                type="button"
                                disabled={!available || Boolean(disabledReason)}
                                className="rounded-md bg-brand-500 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                                onClick={() => openItemModal(item)}
                              >
                                {t.add}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <aside className="rounded-xl bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold">{t.cart}</h2>
              {cart.length === 0 ? <p className="text-sm text-slate-600">{t.emptyCart}</p> : null}

              <div className="space-y-3">
                {cart.map((line) => (
                  <div key={line.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium" dir="ltr">
                        {line.name}
                      </p>
                      <button
                        type="button"
                        onClick={() => setCart((prev) => prev.filter((c) => c.id !== line.id))}
                        className="text-xs text-red-600"
                      >
                        {t.remove}
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-sm">
                      <span>{t.qty}</span>
                      <button
                        type="button"
                        className="rounded border px-2"
                        onClick={() =>
                          setCart((prev) =>
                            prev.map((c) =>
                              c.id === line.id ? { ...c, qty: Math.max(1, c.qty - 1) } : c
                            )
                          )
                        }
                      >
                        -
                      </button>
                      <span>{line.qty}</span>
                      <button
                        type="button"
                        className="rounded border px-2"
                        onClick={() =>
                          setCart((prev) =>
                            prev.map((c) => (c.id === line.id ? { ...c, qty: c.qty + 1 } : c))
                          )
                        }
                      >
                        +
                      </button>
                    </div>
                    {line.notes ? <p className="mt-2 text-xs text-slate-600">{t.notes}: {line.notes}</p> : null}
                    {line.selected_modifiers.length > 0 ? (
                      <p className="mt-1 text-xs text-slate-600" dir="ltr">
                        {line.selected_modifiers.map((m) => m.name).join(', ')}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={submitOrder}
                disabled={isSubmitting || Boolean(disabledReason)}
                className="mt-4 w-full rounded-lg bg-brand-700 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isSubmitting ? t.submitting : t.submit}
              </button>
            </aside>
          </div>
        )}
      </div>

      {modal ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-4 shadow-lg">
            <h3 className="text-lg font-semibold" dir="ltr">
              {modal.item.name}
            </h3>
            <p className="text-sm text-slate-600">{modal.item.description}</p>

            <div className="mt-3 flex items-center gap-2">
              <span>{t.qty}</span>
              <button
                type="button"
                className="rounded border px-2"
                onClick={() => setModal((prev) => (prev ? { ...prev, qty: Math.max(1, prev.qty - 1) } : prev))}
              >
                -
              </button>
              <span>{modal.qty}</span>
              <button
                type="button"
                className="rounded border px-2"
                onClick={() => setModal((prev) => (prev ? { ...prev, qty: prev.qty + 1 } : prev))}
              >
                +
              </button>
            </div>

            <label className="mt-3 block text-sm">
              {t.notes}
              <textarea
                className="mt-1 w-full rounded-md border border-slate-300 p-2"
                value={modal.notes}
                onChange={(e) => setModal((prev) => (prev ? { ...prev, notes: e.target.value } : prev))}
                maxLength={200}
              />
            </label>

            <div className="mt-4 space-y-3">
              {itemGroupsForModal.map((groupRule) => {
                const group = modifierGroupById[groupRule.modifier_group_id];
                if (!group) return null;
                const groupModifiers = modifiersByGroup[group.id] ?? [];
                const selected = modal.selectedByGroup[group.id] ?? [];

                return (
                  <div key={group.id} className="rounded-md border border-slate-200 p-3">
                    <p className="font-medium" dir="ltr">
                      {group.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {groupRule.is_required ? t.required : t.optional} · {t.minMax(groupRule.min_select, groupRule.max_select)}
                    </p>
                    <div className="mt-2 grid gap-2">
                      {groupModifiers.map((modifier) => (
                        <label key={modifier.id} className="flex items-center gap-2 text-sm" dir="ltr">
                          <input
                            type={groupRule.max_select > 1 ? 'checkbox' : 'radio'}
                            checked={selected.includes(modifier.id)}
                            onChange={() => toggleModifier(group.id, modifier.id, groupRule.max_select)}
                          />
                          <span>{modifier.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-md border px-3 py-1" onClick={() => setModal(null)}>
                {t.cancel}
              </button>
              <button type="button" className="rounded-md bg-brand-500 px-3 py-1 text-white" onClick={confirmAdd}>
                {t.confirmAdd}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
