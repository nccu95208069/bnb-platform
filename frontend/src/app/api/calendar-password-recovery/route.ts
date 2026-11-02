import { after, type NextRequest } from 'next/server';
import { handleRecovery } from './handler';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return handleRecovery(request, after);
}
