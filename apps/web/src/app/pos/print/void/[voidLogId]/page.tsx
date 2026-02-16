import { VoidTicketPage } from '@/components/pos/print-void-ticket-page';

type Props = {
  params: {
    voidLogId: string;
  };
};

export default function PosPrintVoidPage({ params }: Props) {
  return <VoidTicketPage voidLogId={params.voidLogId} />;
}
