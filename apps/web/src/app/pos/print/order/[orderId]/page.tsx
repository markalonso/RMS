import { KitchenTicketPage } from '@/components/pos/print-kitchen-ticket-page';

type Props = {
  params: {
    orderId: string;
  };
};

export default function PosPrintOrderPage({ params }: Props) {
  return <KitchenTicketPage orderId={params.orderId} />;
}
