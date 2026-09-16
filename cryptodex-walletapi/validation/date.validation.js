// import helpers
import isEmpty from "../lib/isEmpty.js";

export const dateValidation = (req, res, next) => {
    let errors = {};
    let reqQuery = req.query;

    if (reqQuery.type == "searchType") {
        let parseData = JSON.parse(reqQuery.fillter);

        let startDate =
            Object.keys(parseData)[0] == "sefd_orderDate"
                ? parseData.sefd_orderDate.startDate
                : parseData.sefd_createdAt.startDate;
        let endDate =
            Object.keys(parseData)[0] == "sefd_orderDate"
                ? parseData.sefd_orderDate.endDate
                : parseData.sefd_createdAt.endDate;

        startDate = new Date(startDate);
        endDate = new Date(endDate);
        let currentDate = new Date();
        if (
            isEmpty(
                Object.keys(parseData)[0] == "sefd_orderDate" //when searching date field is orderdate,
                    ? parseData.sefd_orderDate.startDate
                    : parseData.sefd_createdAt.startDate
            )
        ) {
            errors.date = " Choose Start Date";
        } else if (startDate.getTime() > currentDate.getTime()) {
            errors.date = " Invalid Start Date";
        } else if (
            isEmpty(
                Object.keys(parseData)[0] == "sefd_orderDate" // when searching date field is orderdate,
                    ? parseData.sefd_orderDate.endDate
                    : parseData.sefd_createdAt.endDate
            )
        ) {
            errors.date = " Choose End Date";
        } else if (endDate.getTime() > currentDate.getTime()) {
            errors.date = " Invalid End Date";
        }
        if (startDate != "" && endDate != "") {
            if (startDate.getTime() > endDate.getTime()) {
                errors.date = " Invalid Date";
            }
        }
    }
    if (!isEmpty(errors)) {
        return res.status(400).json({ success: false, errors: errors });
    } else {
        return next();
    }
};
