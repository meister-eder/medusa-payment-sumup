"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SumUpClientError = void 0;
/**
 * Typed error thrown by SumUpClient for all non-OK HTTP responses and
 * network-level failures.  Callers can inspect `.type` to decide how to
 * handle (surface to user, retry, fall through, etc.).
 */
class SumUpClientError extends Error {
    constructor(message, type, statusCode) {
        super(message);
        this.name = "SumUpClientError";
        this.type = type;
        this.statusCode = statusCode;
    }
}
exports.SumUpClientError = SumUpClientError;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvcHJvdmlkZXJzL3N1bXVwL3R5cGVzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQTJHQTs7OztHQUlHO0FBQ0gsTUFBYSxnQkFBaUIsU0FBUSxLQUFLO0lBSXpDLFlBQ0UsT0FBZSxFQUNmLElBQW9CLEVBQ3BCLFVBQW1CO1FBRW5CLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNmLElBQUksQ0FBQyxJQUFJLEdBQUcsa0JBQWtCLENBQUM7UUFDL0IsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7UUFDakIsSUFBSSxDQUFDLFVBQVUsR0FBRyxVQUFVLENBQUM7SUFDL0IsQ0FBQztDQUNGO0FBZEQsNENBY0MifQ==