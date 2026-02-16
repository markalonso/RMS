import { ReceiptTicketPage } from '@/components/pos/print-receipt-ticket-page';

type Props = { params: { sessionId: string } };

export default function PosPrintReceiptPage({ params }: Props) {
  return <ReceiptTicketPage sessionId={params.sessionId} />;
}
