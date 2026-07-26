import { Controller, Delete, Get, HttpCode, Post, Put, type Type } from "@nestjs/common";

const ROUTE_DECORATORS = {
	get: Get,
	post: Post,
	put: Put,
	delete: Delete,
} as const;

export type RouteMethod = keyof typeof ROUTE_DECORATORS;

export function applyController(target: Type<unknown>, path: string): void {
	Controller(path)(target);
}

export function applyRoute(target: object, key: string, method: RouteMethod, path: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	if (!descriptor) throw new Error(`Missing route method: ${key}`);
	ROUTE_DECORATORS[method](path)(target, key, descriptor);
}

export function applyHttpCode(target: object, key: string, statusCode: number): void {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	if (!descriptor) throw new Error(`Missing route method: ${key}`);
	HttpCode(statusCode)(target, key, descriptor);
}

export function applyParameter(target: object, key: string, index: number, decorator: ParameterDecorator): void {
	decorator(target, key, index);
}
