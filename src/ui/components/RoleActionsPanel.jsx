import { useEffect, useMemo, useState } from 'react';

const ROLE_TABS = [
  { id: 'driver', label: 'Driver', color: 'var(--driver-color)' },
  { id: 'restaurant', label: 'Comercio', color: 'var(--restaurant-color)' },
  { id: 'customer', label: 'Cliente', color: 'var(--customer-color)' },
  { id: 'engine', label: 'Engine', color: 'var(--accent)' },
];

const ENGINE_PARAM_GROUPS = [
  {
    title: 'Asignación',
    items: [
      { key: 'assignment_batch_size', label: 'Batch size', defaultValue: 4, description: 'Pedidos evaluados por tanda.' },
      { key: 'assignment_retry_base_s', label: 'Retry base (s)', defaultValue: 2, description: 'Backoff inicial para reintentos.' },
      { key: 'assignment_retry_max_s', label: 'Retry máx (s)', defaultValue: 60, description: 'Tope del backoff de reintento.' },
      { key: 'simulation_budget_per_tick', label: 'Budget / tick', defaultValue: 75, description: 'Candidatos simulados por tick.' },
      { key: 'driver_offer_timeout_s', label: 'Ventana de oferta', defaultValue: 120, description: 'Tiempo simulado para aceptar o rechazar una oferta.' },
      { key: 'max_customer_restaurant_distance_km', label: 'Distancia máx C↔R', defaultValue: 5, description: 'Límite global entre cliente y comercio.' },
    ],
  },
  {
    title: 'Costos y fairness',
    items: [
      { key: 'fairness_penalty_per_order_s', label: 'Fairness penalty', defaultValue: 120, description: 'Penalización por carga activa del driver.' },
      { key: 'soft_sla_penalty_factor', label: 'Soft SLA factor', defaultValue: 2, description: 'Factor para castigar retraso sobre SLA.' },
      { key: 'hard_sla_penalty_s', label: 'Hard SLA penalty', defaultValue: 3000, description: 'Golpe fijo cuando se rompe SLA.' },
      { key: 'pickup_proximity_penalty_factor', label: 'Pickup proximity', defaultValue: 0.35, description: 'Peso por distancia driver → pickup.' },
    ],
  },
  {
    title: 'Transferencias',
    items: [
      { key: 'transfer_cooldown_s', label: 'Cooldown transfer', defaultValue: 60, description: 'Enfriamiento antes de retransferir.' },
      { key: 'transfer_min_gain_s', label: 'Gain mínimo', defaultValue: 10, description: 'Ganancia mínima para aceptar rebalanceo.' },
      { key: 'transfer_max_iterations', label: 'Iteraciones máx', defaultValue: 5, description: 'Límite del motor de rebalanceo.' },
      { key: 'reconnect_window_s', label: 'Ventana reconexión', defaultValue: 600, description: 'Tiempo para reconectar órdenes en ruta.' },
    ],
  },
];

const EMPTY_FEEDBACK = {
  driver: null,
  restaurant: null,
  customer: null,
  engine: null,
};

export default function RoleActionsPanel({ sim }) {
  const world = sim.world;

  const drivers = useMemo(() => Object.values(world.drivers), [world.drivers]);
  const restaurants = useMemo(() => Object.values(world.restaurants), [world.restaurants]);
  const customers = useMemo(() => Object.values(world.customers), [world.customers]);
  const orders = useMemo(() => Object.values(world.orders), [world.orders]);

  const [activeTab, setActiveTab] = useState('driver');
  const [driverId, setDriverId] = useState('');
  const [driverOrderId, setDriverOrderId] = useState('');
  const [restaurantId, setRestaurantId] = useState('');
  const [restaurantOrderId, setRestaurantOrderId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customerOrderId, setCustomerOrderId] = useState('');
  const [customerRestaurantId, setCustomerRestaurantId] = useState('');
  const [customerAmount, setCustomerAmount] = useState(15000);
  const [paramEditing, setParamEditing] = useState({});
  const [feedback, setFeedback] = useState(EMPTY_FEEDBACK);

  useEffect(() => {
    if (!driverId || !world.drivers[driverId]) setDriverId(drivers[0]?.id ?? '');
  }, [drivers, driverId, world.drivers]);

  useEffect(() => {
    if (!restaurantId || !world.restaurants[restaurantId]) setRestaurantId(restaurants[0]?.id ?? '');
  }, [restaurants, restaurantId, world.restaurants]);

  useEffect(() => {
    if (!customerId || !world.customers[customerId]) setCustomerId(customers[0]?.id ?? '');
  }, [customers, customerId, world.customers]);

  useEffect(() => {
    if (!customerRestaurantId || !world.restaurants[customerRestaurantId]) {
      setCustomerRestaurantId(restaurants[0]?.id ?? '');
    }
  }, [restaurants, customerRestaurantId, world.restaurants]);

  const driverOrders = useMemo(() => {
    if (!driverId) return [];
    return orders.filter(order => order.driver_id === driverId || !order.driver_id || ['queued', 'offer_pending'].includes(order.status));
  }, [orders, driverId]);

  const restaurantOrders = useMemo(() => {
    if (!restaurantId) return [];
    return orders.filter(order => order.restaurant_id === restaurantId);
  }, [orders, restaurantId]);

  const customerOrders = useMemo(() => {
    if (!customerId) return [];
    return orders.filter(order => order.customer_id === customerId);
  }, [orders, customerId]);

  useEffect(() => {
    if (!driverOrderId || !driverOrders.some(order => order.id === driverOrderId)) setDriverOrderId(driverOrders[0]?.id ?? '');
  }, [driverOrders, driverOrderId]);

  useEffect(() => {
    if (!restaurantOrderId || !restaurantOrders.some(order => order.id === restaurantOrderId)) setRestaurantOrderId(restaurantOrders[0]?.id ?? '');
  }, [restaurantOrders, restaurantOrderId]);

  useEffect(() => {
    if (!customerOrderId || !customerOrders.some(order => order.id === customerOrderId)) setCustomerOrderId(customerOrders[0]?.id ?? '');
  }, [customerOrders, customerOrderId]);

  const selectedDriver = driverId ? world.drivers[driverId] : null;
  const selectedDriverOrder = driverOrderId ? world.orders[driverOrderId] : null;
  const selectedRestaurant = restaurantId ? world.restaurants[restaurantId] : null;
  const selectedRestaurantOrder = restaurantOrderId ? world.orders[restaurantOrderId] : null;
  const selectedCustomer = customerId ? world.customers[customerId] : null;
  const selectedCustomerOrder = customerOrderId ? world.orders[customerOrderId] : null;

  function setRoleFeedback(role, result) {
    if (!result) return;
    setFeedback(prev => ({
      ...prev,
      [role]: {
        ok: result.ok !== false,
        message: result.message,
      },
    }));
  }

  function doRoleAction(role, action, payload = {}) {
    const result = sim.roleAction(role, action, payload);
    setRoleFeedback(role, result);
  }

  function saveEngineParam(key, value) {
    const result = sim.updateWorldParam(key, value);
    setRoleFeedback('engine', result);
  }

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', background: 'var(--bg-0)' }}>
        {ROLE_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1,
              padding: '9px 6px',
              fontSize: 11,
              fontWeight: 700,
              background: 'none',
              color: activeTab === tab.id ? tab.color : 'var(--text-1)',
              borderBottom: activeTab === tab.id ? `2px solid ${tab.color}` : '2px solid transparent',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {activeTab === 'driver' && (
          <RoleCard title="Acciones del driver" color="var(--driver-color)">
            <Selector
              label="Seleccionar driver"
              value={driverId}
              onChange={setDriverId}
              options={drivers.map(driver => ({ value: driver.id, label: `${driver.name} · ${driver.status}` }))}
              emptyLabel="No hay drivers"
            />
            <Selector
              label="Pedido / oferta"
              value={driverOrderId}
              onChange={setDriverOrderId}
              options={driverOrders.map(order => ({ value: order.id, label: `${order.id} · ${order.status}` }))}
              emptyLabel="Sin pedidos vinculados"
            />
            <MiniState>
              {selectedDriver ? (
                <>
                  <MiniItem label="Estado" value={selectedDriver.status} />
                  <MiniItem label="Disponible" value={(selectedDriver.is_available ?? true) ? 'Sí' : 'No'} />
                  <MiniItem label="Pedidos" value={(selectedDriver.orders ?? []).length} />
                </>
              ) : 'Selecciona un driver para habilitar acciones'}
            </MiniState>
            <OrderSnapshot
              title="Pedido / oferta seleccionada"
              order={selectedDriverOrder}
              restaurant={selectedDriverOrder ? world.restaurants[selectedDriverOrder.restaurant_id] : null}
              customer={selectedDriverOrder ? world.customers[selectedDriverOrder.customer_id] : null}
            />
            <ButtonGrid>
              <ActionButton disabled={!selectedDriver} onClick={() => doRoleAction('driver', 'toggleAvailability', { driverId })}>Disponibilidad</ActionButton>
              <ActionButton disabled={!selectedDriver} onClick={() => doRoleAction('driver', 'reportLocation', { driverId })}>Ubicación</ActionButton>
              <ActionButton disabled={!selectedDriver || !driverOrderId} onClick={() => doRoleAction('driver', 'acceptOffer', { driverId, orderId: driverOrderId })}>Aceptar oferta</ActionButton>
              <ActionButton disabled={!selectedDriver || !driverOrderId} onClick={() => doRoleAction('driver', 'rejectOffer', { driverId, orderId: driverOrderId })}>Rechazar oferta</ActionButton>
              <ActionButton disabled={!selectedDriver || !driverOrderId} onClick={() => doRoleAction('driver', 'claimOrder', { driverId, orderId: driverOrderId })}>Claim</ActionButton>
              <ActionButton disabled={!selectedDriver || !driverOrderId} onClick={() => doRoleAction('driver', 'requestRebalance', { driverId, orderId: driverOrderId })}>Rebalanceo</ActionButton>
              <ActionButton disabled={!selectedDriver || !driverOrderId} onClick={() => doRoleAction('driver', 'releaseOrder', { driverId, orderId: driverOrderId })}>Liberar pedido</ActionButton>
            </ButtonGrid>
            <FeedbackBanner feedback={feedback.driver} />
          </RoleCard>
        )}

        {activeTab === 'restaurant' && (
          <RoleCard title="Acciones del comercio" color="var(--restaurant-color)">
            <Selector
              label="Seleccionar comercio"
              value={restaurantId}
              onChange={setRestaurantId}
              options={restaurants.map(restaurant => ({ value: restaurant.id, label: `${restaurant.name} · prep ${restaurant.prep_time_s}s` }))}
              emptyLabel="No hay comercios"
            />
            <Selector
              label="Pedido del comercio"
              value={restaurantOrderId}
              onChange={setRestaurantOrderId}
              options={restaurantOrders.map(order => ({ value: order.id, label: `${order.id} · ${order.status} · cocina ${order.kitchen_status}` }))}
              emptyLabel="Sin pedidos del comercio"
            />
            <MiniState>
              {selectedRestaurant ? (
                <>
                  <MiniItem label="Operación" value={(selectedRestaurant.manual_open_override ?? true) ? 'Abierta' : 'Pausada'} />
                  <MiniItem label="Prep" value={`${selectedRestaurant.prep_time_s}s`} />
                  <MiniItem label="Pedidos" value={restaurantOrders.length} />
                </>
              ) : 'Selecciona un comercio para habilitar acciones'}
            </MiniState>
            <OrderSnapshot
              title="Pedido seleccionado"
              order={selectedRestaurantOrder}
              restaurant={selectedRestaurant}
              customer={selectedRestaurantOrder ? world.customers[selectedRestaurantOrder.customer_id] : null}
            />
            <ButtonGrid>
              <ActionButton disabled={!selectedRestaurant} onClick={() => doRoleAction('restaurant', 'toggleOpen', { restaurantId })}>Abrir / pausar</ActionButton>
              <ActionButton disabled={!selectedRestaurant} onClick={() => doRoleAction('restaurant', 'speedPrepUp', { restaurantId })}>Prep -60s</ActionButton>
              <ActionButton disabled={!selectedRestaurant} onClick={() => doRoleAction('restaurant', 'slowPrepDown', { restaurantId })}>Prep +60s</ActionButton>
              <ActionButton disabled={!selectedRestaurant || !restaurantOrderId} onClick={() => doRoleAction('restaurant', 'markPreparing', { restaurantId, orderId: restaurantOrderId })}>En preparación</ActionButton>
              <ActionButton disabled={!selectedRestaurant || !restaurantOrderId} onClick={() => doRoleAction('restaurant', 'markReady', { restaurantId, orderId: restaurantOrderId })}>Marcar listo</ActionButton>
              <ActionButton disabled={!selectedRestaurant || !restaurantOrderId} onClick={() => doRoleAction('restaurant', 'sendSuggestion', { restaurantId, orderId: restaurantOrderId })}>Sugerencia</ActionButton>
              <ActionButton disabled={!selectedRestaurant || !restaurantOrderId} onClick={() => doRoleAction('restaurant', 'cancelOrder', { restaurantId, orderId: restaurantOrderId })}>Cancelar pedido</ActionButton>
            </ButtonGrid>
            <FeedbackBanner feedback={feedback.restaurant} />
          </RoleCard>
        )}

        {activeTab === 'customer' && (
          <RoleCard title="Acciones del cliente" color="var(--customer-color)">
            <Selector
              label="Seleccionar cliente"
              value={customerId}
              onChange={setCustomerId}
              options={customers.map(customer => ({ value: customer.id, label: customer.name }))}
              emptyLabel="No hay clientes"
            />
            <Selector
              label="Pedido del cliente"
              value={customerOrderId}
              onChange={setCustomerOrderId}
              options={customerOrders.map(order => ({ value: order.id, label: `${order.id} · ${order.status}` }))}
              emptyLabel="Sin pedidos del cliente"
            />
            <div className="field-row" style={{ marginBottom: 8 }}>
              <div className="field">
                <label>Comercio para crear pedido</label>
                <select value={customerRestaurantId} onChange={e => setCustomerRestaurantId(e.target.value)}>
                  {restaurants.length === 0 ? <option value="">No hay comercios</option> : restaurants.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Monto</label>
                <input type="number" min="1000" step="500" value={customerAmount} onChange={e => setCustomerAmount(Number(e.target.value) || 0)} />
              </div>
            </div>
            <MiniState>
              {selectedCustomer ? (
                <>
                  <MiniItem label="Pedidos" value={customerOrders.length} />
                  <MiniItem label="Límite global C↔R" value={`${world.params?.max_customer_restaurant_distance_km ?? 5} km`} />
                </>
              ) : 'Selecciona un cliente para habilitar acciones'}
            </MiniState>
            <OrderSnapshot
              title="Pedido seleccionado"
              order={selectedCustomerOrder}
              restaurant={selectedCustomerOrder ? world.restaurants[selectedCustomerOrder.restaurant_id] : null}
              customer={selectedCustomer}
            />
            <ButtonGrid>
              <ActionButton disabled={!selectedCustomer || !customerRestaurantId} onClick={() => doRoleAction('customer', 'placeOrder', { customerId, restaurantId: customerRestaurantId, amountCents: customerAmount })}>Crear pedido</ActionButton>
              <ActionButton disabled={!selectedCustomer || !customerOrderId} onClick={() => doRoleAction('customer', 'cancelOrder', { customerId, orderId: customerOrderId })}>Cancelar pedido</ActionButton>
              <ActionButton disabled={!selectedCustomer || !customerOrderId} onClick={() => doRoleAction('customer', 'acceptSuggestion', { customerId, orderId: customerOrderId })}>Aceptar sugerencia</ActionButton>
              <ActionButton disabled={!selectedCustomer || !customerOrderId} onClick={() => doRoleAction('customer', 'rejectSuggestion', { customerId, orderId: customerOrderId })}>Rechazar sugerencia</ActionButton>
              <ActionButton disabled={!selectedCustomer || !customerOrderId} onClick={() => doRoleAction('customer', 'requestSupport', { customerId, orderId: customerOrderId })}>Soporte</ActionButton>
            </ButtonGrid>
            <FeedbackBanner feedback={feedback.customer} />
          </RoleCard>
        )}

        {activeTab === 'engine' && (
          <RoleCard title="Parámetros del engine" color="var(--accent)">
            <div style={{ fontSize: 11, color: 'var(--text-1)', marginBottom: 10 }}>
              Incluye la ventana de oferta del driver y la distancia máxima global cliente↔comercio.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {ENGINE_PARAM_GROUPS.map(group => (
                <div key={group.title} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ padding: '8px 10px', background: 'var(--bg-0)', fontSize: 11, fontWeight: 700, color: 'var(--text-1)', letterSpacing: 0.3 }}>
                    {group.title}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {group.items.map(item => {
                      const currentValue = world.params?.[item.key] ?? item.defaultValue;
                      const editingValue = paramEditing[item.key] ?? String(currentValue);
                      const dirty = String(currentValue) !== String(editingValue);

                      return (
                        <div key={item.key} style={{ padding: '9px 10px', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1.3fr 1.4fr 110px 84px', gap: 8, alignItems: 'center' }}>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 600 }}><code>{item.key}</code></div>
                            <div style={{ fontSize: 10, color: 'var(--text-2)' }}>{item.label}</div>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-1)', lineHeight: 1.35 }}>{item.description}</div>
                          <input
                            type="number"
                            value={editingValue}
                            onChange={e => setParamEditing(prev => ({ ...prev, [item.key]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                saveEngineParam(item.key, editingValue);
                                setParamEditing(prev => ({ ...prev, [item.key]: String(Number(editingValue)) }));
                              }
                            }}
                            style={{ borderColor: dirty ? 'var(--accent)' : 'var(--border)' }}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <button className={`btn ${dirty ? 'primary' : ''}`} style={{ justifyContent: 'center', padding: '4px 8px' }} onClick={() => saveEngineParam(item.key, editingValue)}>
                              Guardar
                            </button>
                            <button className="btn" style={{ justifyContent: 'center', padding: '3px 8px' }} onClick={() => {
                              setParamEditing(prev => ({ ...prev, [item.key]: String(item.defaultValue) }));
                              saveEngineParam(item.key, item.defaultValue);
                            }}>
                              Default
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <FeedbackBanner feedback={feedback.engine} compact />
          </RoleCard>
        )}
      </div>
    </div>
  );
}

function RoleCard({ title, color, children }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg-1)' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Selector({ label, value, onChange, options, emptyLabel }) {
  return (
    <div className="field" style={{ marginBottom: 8 }}>
      <label>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}>
        {options.length === 0 ? <option value="">{emptyLabel}</option> : options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

function ButtonGrid({ children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
      {children}
    </div>
  );
}

function ActionButton({ children, ...props }) {
  return (
    <button className="btn" style={{ justifyContent: 'center', minHeight: 32 }} {...props}>
      {children}
    </button>
  );
}

function MiniState({ children }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border)', fontSize: 10, color: 'var(--text-1)' }}>
      {children}
    </div>
  );
}

function MiniItem({ label, value }) {
  return (
    <span>
      <strong style={{ color: 'var(--text-0)', fontWeight: 600 }}>{label}:</strong> {value}
    </span>
  );
}

function OrderSnapshot({ title, order, restaurant, customer }) {
  return (
    <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-0)', border: '1px solid var(--border)', fontSize: 10, color: 'var(--text-1)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-0)', marginBottom: 6 }}>{title}</div>
      {!order ? (
        <span>No hay pedido seleccionado.</span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <MiniItem label="ID" value={order.id} />
          <MiniItem label="Estado" value={order.status} />
          <MiniItem label="Cocina" value={order.kitchen_status ?? '—'} />
          <MiniItem label="Comercio" value={restaurant?.name ?? order.restaurant_id} />
          <MiniItem label="Cliente" value={customer?.name ?? order.customer_id} />
          <MiniItem label="Expira" value={Number.isFinite(order.offer_expires_at) ? `${Math.max(0, Math.round(order.offer_expires_at))}s` : '—'} />
          <MiniItem label="Sugerencia" value={order.suggestion_status ?? '—'} />
          <MiniItem label="Soporte" value={order.support_status ?? '—'} />
        </div>
      )}
    </div>
  );
}

function FeedbackBanner({ feedback, compact = false }) {
  if (!feedback?.message) return null;

  return (
    <div
      style={{
        marginTop: compact ? 10 : 12,
        padding: compact ? '8px 10px' : '9px 10px',
        borderRadius: 8,
        border: `1px solid ${feedback.ok ? 'rgba(63,185,80,0.35)' : 'rgba(248,81,73,0.45)'}`,
        background: feedback.ok ? 'rgba(63,185,80,0.12)' : 'rgba(248,81,73,0.12)',
        color: feedback.ok ? 'var(--green)' : 'var(--red)',
        fontSize: 11,
        lineHeight: 1.35,
      }}
    >
      {feedback.message}
    </div>
  );
}
