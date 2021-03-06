/**
 * Plugin for instrumenting Ajax requests.
 * 
 * The AJAX requests are isntrumented alongside with all event listeners attached to the them.
 */

window.inspectIT.registerPlugin("ajaxInstrumentation", (function() {

	var TYPE_AJAX_REQUEST = "ajaxRequest";

	var inspectIT = window.inspectIT;

	function initAjaxInstrumentation() {
		var uninstrumentedOpen = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function(method, url, async, user, pw) {
			var requestObj = this;

			// only instrument if instrumenation is enabled
			if (inspectIT.instrumentation.isEnabled()) {

				// all methods in here will have access to this object (principle of closures)
				// a record is created for every open-call (should only happen once per XMLHTTPRequest)
				var ajaxRecord = inspectIT.createEUMElement(TYPE_AJAX_REQUEST);
				ajaxRecord.method = method;
				ajaxRecord.url = url;
				//default value for async is true, if a value is given get its truthiness by double negation
				ajaxRecord.isAsync = (typeof async === "undefined") ? true : !!async;

				ajaxRecord.require("ajaxInfo");
				ajaxRecord.markRelevant(); // requests are always relevant

				// store the record with the XMLHTTPRequest object to allow the correlation of listeners
				Object.defineProperty(requestObj, "_inspectIT_ajax_record", {
					value : ajaxRecord
				});
				var uninstrumentedSend = requestObj.send;

				// the "this" keyword will point to the actual XMLHTTPRequest object, so we overwrite the send method
				// of just this object (makes sure we use our specific ajaxRecord object)
				requestObj.send = function(arg) {
					// possibly disable instrumentation
					if (!inspectIT.instrumentation.isEnabled()) {
						return uninstrumentedSend.apply(requestObj, arguments);
					}

					setCorrelationHeaders(requestObj, ajaxRecord);
					// read the href here because it might have changed in the meantime
					ajaxRecord.baseUrl = window.location.href;

					if (!async) {
						// snychronous instrumentation is straightforward

						ajaxRecord.buildTrace(true, function() {
							return uninstrumentedSend.apply(requestObj, arguments);
						});
						ajaxRecord.status = requestObj.status;
						ajaxRecord.markComplete("ajaxInfo");
					} else {
						// asnychronous instrumentation

						// track this asynchronous call (e.g. set the parent-call)
						ajaxRecord.buildTrace(false, function() {
						});
						var startTime = inspectIT.util.timestampMS();
						ajaxRecord.setEnterTimestamp(startTime);

						// this gives us the time between sending the request
						// and getting back the response (better than below)
						// -> works in all modern browsers
						inspectIT.instrumentation.runWithout(function() {
							requestObj.addEventListener("progress", inspectIT.instrumentation.disableFor(function(oEvent) {
								if (!("duration" in ajaxRecord) && oEvent.lengthComputable) {
									var percentComplete = oEvent.loaded / oEvent.total;
									if (percentComplete >= 1) { // -> we're finished
										ajaxRecord.status = requestObj.status;
										ajaxRecord.setDuration(inspectIT.util.timestampMS() - startTime);
										ajaxRecord.markComplete("ajaxInfo");
									}
								}
							}));
						});

						// this gives us the time between send and finish of all
						// javascript tasks executed after the request
						// -> fallback solution if progress is not available
						inspectIT.instrumentation.runWithout(function() {
							requestObj.addEventListener("loadend", inspectIT.instrumentation.disableFor(function(oEvent) {
								// check if the fallback is required
								if (!("duration" in ajaxRecord)) {
									ajaxRecord.status = requestObj.status;
									ajaxRecord.setDuration(inspectIT.util.timestampMS() - startTime);
									ajaxRecord.markComplete("ajaxInfo");
								}
							}));
						});

						return uninstrumentedSend.apply(requestObj, arguments);

					}
				};
			}
			return uninstrumentedOpen.apply(requestObj, arguments);
		}

		// instrument listeners on monitored ajax requests
		function ajaxListenerInstrumentation(executeOriginalListener, originalCallback, event) {

			var ajax = event.target;
			if ("_inspectIT_ajax_record" in ajax) { // check if the ajax was instrumented
				var ajaxRecord = ajax._inspectIT_ajax_record;
				var listenerRecord = inspectIT.createEUMElement("listenerExecution");
				listenerRecord.require("listenerData");
				listenerRecord.setParent(ajaxRecord);

				var funcName = inspectIT.util.getFunctionName(originalCallback);
				if (funcName != "") {
					listenerRecord.functionName = funcName;
				}
				listenerRecord.eventType = event.type;

				// execute the lsitener while build the trace
				listenerRecord.buildTrace(true, executeOriginalListener);

				listenerRecord.markComplete("listenerData");
			} else {
				// not an monitored ajax request, continue as if nothing happened
				executeOriginalListener();
			}
		}
		inspectIT.instrumentation.instrumentEventListener(ajaxListenerInstrumentation);

	}

	/**
	 * Sets the tracing correlation headers for the given request.
	 * 
	 * @param requestObj
	 *            the XMLHTTPRequest to correlate
	 * @param ajaxRecord
	 *            the ajaxRecord for the orresponding request
	 * @returns
	 */
	function setCorrelationHeaders(requestObj, ajaxRecord) {
		var parentSpan = inspectIT.traceBuilder.getCurrentParent();
		var traceId;
		if (parentSpan) {
			if ("traceId" in parentSpan) {
				traceId = parentSpan.traceId;
			} else {
				traceId = parentSpan.id;
			}
		} else {
			traceId = ajaxRecord.id;
		}
		requestObj.setRequestHeader("inspectit_spanid", ajaxRecord.id);
		requestObj.setRequestHeader("inspectit_traceid", traceId);
	}

	return {
		init : initAjaxInstrumentation
	}
})());