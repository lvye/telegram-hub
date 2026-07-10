export type DeliveryStatus =
	| 'blocked'
	| 'dead'
	| 'queued'
	| 'ready'
	| 'retry'
	| 'sending'
	| 'sent';

export interface ItemInput {
	externalId: string;
	title: string | null;
	description: string | null;
	link: string | null;
	author: string | null;
	imageUrl: string | null;
	publishedAt: number | null;
	metadata?: Record<string, unknown>;
}

export interface DeliveryJob {
	version: 1;
	deliveryId: number;
}

export interface DispatchableDelivery {
	deliveryId: number;
}

export interface DeliveryState {
	id: number;
	status: DeliveryStatus;
	attemptCount: number;
	availableAt: number;
	leaseExpiresAt: number | null;
}

export interface DeliveryLease {
	deliveryId: number;
	destinationKey: string;
	leaseToken: string;
	attemptCount: number;
	sourceKey: string;
	externalId: string;
	title: string | null;
	description: string | null;
	link: string | null;
	author: string | null;
	imageUrl: string | null;
	publishedAt: number | null;
}
